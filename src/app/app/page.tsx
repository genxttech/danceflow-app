import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Globe2,
  Layers3,
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

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

type SubscriptionRow = {
  id: string;
  subscription_plan_id: string | null;
  status: string | null;
  billing_interval: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  updated_at: string;
};

type SubscriptionPlanRow = {
  id: string;
  code: string;
  name: string;
};

type ClientRow = {
  id: string;
};

type HostStudioPortalLink = {
  client_id: string;
  studio_id: string;
  studio_name: string;
  studio_slug: string;
};

type AppointmentRow = {
  id: string;
  title: string | null;
  starts_at: string;
  status: string | null;
};

type MembershipRow = {
  id: string;
  status: string | null;
};

type PackageRow = {
  id: string;
  active: boolean | null;
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
  featured: boolean;
  public_directory_enabled: boolean;
};

type OrganizerRow = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
};

type RegistrationRow = {
  id: string;
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

function planBadgeClass(planCode: string) {
  if (planCode === "pro") {
    return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  }
  if (planCode === "growth") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-600">
      {children}
    </div>
  );
}

export default async function AppDashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const acceptedInviteCountRaw =
    typeof resolvedSearchParams.team_invite_accepted === "string"
      ? resolvedSearchParams.team_invite_accepted
      : null;

  const acceptedInviteCount = acceptedInviteCountRaw
    ? Number.parseInt(acceptedInviteCountRaw, 10)
    : 0;

  const showInviteAcceptedBanner =
    Number.isFinite(acceptedInviteCount) && acceptedInviteCount > 0;

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;
  const organizerWorkspace = isOrganizerRole(context.studioRole);
  const accessibleStudios = await getAccessibleStudios();

  const currentWorkspace =
    accessibleStudios.find((workspace) => workspace.studioId === studioId) ??
    accessibleStudios.find((workspace) => workspace.isSelected) ??
    null;

  let hostStudioPortalLinks: HostStudioPortalLink[] = [];

  const { data: hostStudioPortalRows, error: hostStudioPortalError } = await supabase
    .from("clients")
    .select(`
      id,
      studio_id,
      studios (
        id,
        name,
        slug
      )
    `)
    .eq("portal_user_id", user.id)
    .eq("is_independent_instructor", true)
    .neq("studio_id", studioId);

  if (hostStudioPortalError) {
    throw new Error(
      `Failed to load host studio portal links: ${hostStudioPortalError.message}`
    );
  }

  hostStudioPortalLinks = (hostStudioPortalRows ?? [])
    .map((row) => {
      const typedRow = row as {
        id: string;
        studio_id: string;
        studios?:
          | { id?: string | null; name?: string | null; slug?: string | null }
          | { id?: string | null; name?: string | null; slug?: string | null }[]
          | null;
      };

      const studioRelation = Array.isArray(typedRow.studios)
        ? typedRow.studios[0]
        : typedRow.studios;

      if (!studioRelation?.slug) return null;

      return {
        client_id: typedRow.id,
        studio_id: typedRow.studio_id,
        studio_name: studioRelation.name ?? "Host Studio",
        studio_slug: studioRelation.slug,
      };
    })
    .filter((row): row is HostStudioPortalLink => Boolean(row));

  await syncStudioNotifications(studioId);

  const [
    { data: workspace, error: workspaceError },
    { data: notifications, error: notificationsError },
    { data: subscription, error: subscriptionError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, stripe_connected_account_id")
      .eq("id", studioId)
      .maybeSingle<WorkspaceRow>(),

    supabase
      .from("notifications")
      .select("id, type, title, body, read_at, created_at")
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false })
      .limit(6),

    supabase
      .from("studio_subscriptions")
      .select(
        "id, subscription_plan_id, status, billing_interval, trial_ends_at, current_period_end, updated_at"
      )
      .eq("studio_id", studioId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<SubscriptionRow>(),
  ]);

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  if (notificationsError) {
    throw new Error(`Failed to load dashboard notifications: ${notificationsError.message}`);
  }

  if (subscriptionError) {
    throw new Error(`Failed to load current subscription: ${subscriptionError.message}`);
  }

  let currentPlan: SubscriptionPlanRow | null = null;
  if (subscription?.subscription_plan_id) {
    const { data: planRow, error: planError } = await supabase
      .from("subscription_plans")
      .select("id, code, name")
      .eq("id", subscription.subscription_plan_id)
      .maybeSingle<SubscriptionPlanRow>();

    if (planError) {
      throw new Error(`Failed to load current plan: ${planError.message}`);
    }

    currentPlan = planRow ?? null;
  }

  const planCode = organizerWorkspace
    ? "organizer"
    : (currentPlan?.code?.trim().toLowerCase() || "starter");
  const planLabel = organizerWorkspace ? "Organizer" : currentPlan?.name || "Starter";
  const unreadCount = ((notifications ?? []) as NotificationRow[]).filter(
    (item) => !item.read_at
  ).length;
  const payoutsReady = Boolean(workspace?.stripe_connected_account_id);

  const typedNotifications = (notifications ?? []) as NotificationRow[];

  if (organizerWorkspace) {
    const [
      { data: events, error: eventsError },
      { data: organizers, error: organizersError },
      { data: registrations, error: registrationsError },
    ] = await Promise.all([
      supabase
        .from("events")
        .select(
          "id, name, slug, event_type, start_date, end_date, visibility, status, featured, public_directory_enabled"
        )
        .eq("studio_id", studioId)
        .order("start_date", { ascending: true })
        .limit(8),

      supabase
        .from("organizers")
        .select("id, name, slug, active")
        .eq("studio_id", studioId)
        .order("name", { ascending: true }),

      supabase
        .from("event_registrations")
        .select("id, payment_status")
        .eq("studio_id", studioId),
    ]);

    if (eventsError) {
      throw new Error(`Failed to load dashboard events: ${eventsError.message}`);
    }
    if (organizersError) {
      throw new Error(`Failed to load dashboard organizers: ${organizersError.message}`);
    }
    if (registrationsError) {
      throw new Error(`Failed to load dashboard registrations: ${registrationsError.message}`);
    }

    const typedEvents = (events ?? []) as EventRow[];
    const typedOrganizers = (organizers ?? []) as OrganizerRow[];
    const typedRegistrations = (registrations ?? []) as RegistrationRow[];

    const registrationIds = typedRegistrations.map((row) => row.id);

    let typedAttendance: AttendanceRow[] = [];
    if (registrationIds.length > 0) {
      const { data: attendanceRows, error: attendanceError } = await supabase
        .from("event_attendance")
        .select("id, event_registration_id, status")
        .in("event_registration_id", registrationIds);

      if (attendanceError) {
        throw new Error(`Failed to load dashboard attendance: ${attendanceError.message}`);
      }

      typedAttendance = (attendanceRows ?? []) as AttendanceRow[];
    }

    const publishedCount = typedEvents.filter(
      (event) => event.status === "published" || event.status === "open"
    ).length;
    const discoveryReadyCount = typedEvents.filter(
      (event) =>
        event.public_directory_enabled &&
        event.visibility === "public" &&
        (event.status === "published" || event.status === "open")
    ).length;
    const paidRegistrationsCount = typedRegistrations.filter(
      (row) => row.payment_status === "paid" || row.payment_status === "partial"
    ).length;
    const checkedInRegistrationIds = new Set(
      typedAttendance
        .filter((row) => row.status === "checked_in")
        .map((row) => row.event_registration_id)
    );
    const checkedInCount = checkedInRegistrationIds.size;
    const primaryOrganizer = typedOrganizers[0] ?? null;

    return (
      <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
        {showInviteAcceptedBanner ? (
          <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
              Access added
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Your team invitation was accepted
            </h2>
            <p className="mt-2 text-sm leading-7 text-slate-700">
              {acceptedInviteCount === 1
                ? "You now have access to a workspace through your invitation."
                : `You now have access to ${acceptedInviteCount} workspaces through your invitations.`}
            </p>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  DanceFlow Organizer Dashboard
                </p>

                <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                  Organizer Dashboard
                </h1>

                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  Run your organizer operations from one place, including events,
                  registrations, check-in, profile readiness, and recent alerts.
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-white/80">
                  <span>
                    Current workspace:{" "}
                    <span className="font-medium text-white">
                      {currentWorkspace?.studioName || workspace?.name || "Organizer Workspace"}
                    </span>
                  </span>
                  <span className="inline-flex rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium ring-1 ring-white/15">
                    {planLabel}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
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
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Events" value={typedEvents.length} icon={CalendarDays} />
              <StatCard label="Published / Open" value={publishedCount} icon={Ticket} />
              <StatCard label="Discovery Ready" value={discoveryReadyCount} icon={Star} />
              <StatCard label="Paid Registrations" value={paidRegistrationsCount} icon={ClipboardList} />
              <StatCard label="Unread Notifications" value={unreadCount} icon={Bell} />
            </div>
          </div>
        </section>

        <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
          <SectionCard
            title="Event Snapshot"
            subtitle="A quick organizer-first summary of publishing and readiness."
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
              <EmptyState>No events yet. Create your first event to begin publishing.</EmptyState>
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
                          <h3 className="text-base font-semibold text-slate-900">{event.name}</h3>
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

                      <Link
                        href={`/app/events/${event.slug}`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-[var(--brand-primary)] hover:underline"
                      >
                        Open
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <div className="space-y-8">
            <SectionCard
              title="Organizer Profile"
              subtitle="Your organizer identity and public presence."
              action={
                <Link
                  href="/app/organizer"
                  className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
                >
                  Open Organizer
                </Link>
              }
            >
              {primaryOrganizer ? (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">{primaryOrganizer.name}</h3>
                      <p className="mt-1 text-sm text-slate-500">/{primaryOrganizer.slug}</p>
                    </div>
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        primaryOrganizer.active
                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                          : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                      }`}
                    >
                      {primaryOrganizer.active ? "Active" : "Needs Attention"}
                    </span>
                  </div>
                </div>
              ) : (
                <EmptyState>No organizer profile yet. Create one to publish events publicly.</EmptyState>
              )}
            </SectionCard>

            <SectionCard
              title="Recent Alerts"
              subtitle="Latest notifications for this workspace."
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
                <EmptyState>No notifications yet.</EmptyState>
              ) : (
                <div className="space-y-3">
                  {typedNotifications.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-medium text-slate-900">{item.title}</p>
                          {item.body ? (
                            <p className="mt-1 text-sm text-slate-600">{item.body}</p>
                          ) : null}
                        </div>
                        <div className="shrink-0 text-xs text-slate-500">
                          {fmtDateTime(item.created_at)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </section>
      </div>
    );
  }

  const isStudioPro = planCode === "pro";
  const isGrowthOrHigher = planCode === "growth" || planCode === "pro";
  const canSeeProEventModule =
  isStudioPro &&
  (context.isPlatformAdmin ||
    context.studioRole === "studio_owner" ||
    context.studioRole === "studio_admin" ||
    context.studioRole === "front_desk");
    const showBillingSetupCard =
    !payoutsReady &&
    (context.isPlatformAdmin || context.studioRole === "studio_owner");

  const [
    { data: clients, error: clientsError },
    { data: appointments, error: appointmentsError },
    { data: memberships, error: membershipsError },
    { data: packages, error: packagesError },
  ] = await Promise.all([
    supabase.from("clients").select("id").eq("studio_id", studioId),
    supabase
      .from("appointments")
      .select("id, title, starts_at, status")
      .eq("studio_id", studioId)
      .order("starts_at", { ascending: true })
      .limit(12),
    isGrowthOrHigher
      ? supabase.from("client_memberships").select("id, status").eq("studio_id", studioId)
      : Promise.resolve({ data: [], error: null }),
    isGrowthOrHigher
      ? supabase.from("client_packages").select("id, active").eq("studio_id", studioId)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (clientsError) {
    throw new Error(`Failed to load dashboard clients: ${clientsError.message}`);
  }
  if (appointmentsError) {
    throw new Error(`Failed to load dashboard appointments: ${appointmentsError.message}`);
  }
  if (membershipsError) {
    throw new Error(`Failed to load dashboard memberships: ${membershipsError.message}`);
  }
  if (packagesError) {
    throw new Error(`Failed to load dashboard packages: ${packagesError.message}`);
  }

  const typedClients = (clients ?? []) as ClientRow[];
  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const typedMemberships = (memberships ?? []) as MembershipRow[];
  const typedPackages = (packages ?? []) as PackageRow[];

  const now = new Date();
  const upcomingAppointments = typedAppointments.filter((item) => {
    const startsAt = new Date(item.starts_at);
    return startsAt >= now && item.status !== "cancelled";
  });

  const activeMembershipsCount = typedMemberships.filter(
    (item) => item.status === "active"
  ).length;

  const activePackagesCount = typedPackages.filter((item) => Boolean(item.active)).length;

  let proEvents: EventRow[] = [];
  let proRegistrations: RegistrationRow[] = [];
  let proOrganizers: OrganizerRow[] = [];

    if (canSeeProEventModule) {
    const [
      { data: events, error: eventsError },
      { data: registrations, error: registrationsError },
      { data: organizers, error: organizersError },
    ] = await Promise.all([
      supabase
        .from("events")
        .select(
          "id, name, slug, event_type, start_date, end_date, visibility, status, featured, public_directory_enabled"
        )
        .eq("studio_id", studioId)
        .order("start_date", { ascending: true })
        .limit(6),
      supabase
        .from("event_registrations")
        .select("id, payment_status")
        .eq("studio_id", studioId),
      supabase
        .from("organizers")
        .select("id, name, slug, active")
        .eq("studio_id", studioId)
        .order("name", { ascending: true }),
    ]);

    if (eventsError) {
      throw new Error(`Failed to load pro dashboard events: ${eventsError.message}`);
    }
    if (registrationsError) {
      throw new Error(`Failed to load pro dashboard registrations: ${registrationsError.message}`);
    }
    if (organizersError) {
      throw new Error(`Failed to load pro dashboard organizers: ${organizersError.message}`);
    }

    proEvents = (events ?? []) as EventRow[];
    proRegistrations = (registrations ?? []) as RegistrationRow[];
    proOrganizers = (organizers ?? []) as OrganizerRow[];
  }

  const planDescriptor =
    planCode === "pro"
      ? "Advanced studio operations plus public event tools."
      : planCode === "growth"
        ? "Packages, memberships, and payments for stronger day-to-day operations."
        : "Core CRM and scheduling for a single studio.";

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      {showInviteAcceptedBanner ? (
        <section className="rounded-[32px] border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Access added
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Your team invitation was accepted
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-700">
            {acceptedInviteCount === 1
              ? "You now have access to a workspace through your invitation."
              : `You now have access to ${acceptedInviteCount} workspaces through your invitations.`}
          </p>
        </section>
      ) : null}

      {hostStudioPortalLinks.length > 0 ? (
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-7">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
                Independent Instructor
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Host Studio Portal
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Access your linked host studio portal to book floor space, view rentals,
                and manage rental payments.
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-3">
            {hostStudioPortalLinks.map((link) => (
              <div
                key={link.client_id}
                className="flex flex-col gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    {link.studio_name}
                  </p>
                  <p className="text-xs text-slate-500">
                    Manage your rental activity with this host studio.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/portal/${encodeURIComponent(link.studio_slug)}`}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                  >
                    Open Portal
                  </Link>
                  <Link
                    href={`/portal/${encodeURIComponent(link.studio_slug)}/floor-space`}
                    className="rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90"
                  >
                    Book Floor Space
                  </Link>
                  <Link
                    href={`/portal/${encodeURIComponent(
                      link.studio_slug
                    )}/floor-space/my-rentals`}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                  >
                    View Rentals
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Studio Dashboard
              </p>

              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Studio Dashboard
              </h1>

              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Run your studio from one place with a dashboard aligned to your current
                plan instead of organizer-first event tools.
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-white/80">
                <span>
                  Current workspace:{" "}
                  <span className="font-medium text-white">
                    {currentWorkspace?.studioName || workspace?.name || "Studio Workspace"}
                  </span>
                </span>

                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${planBadgeClass(
                    planCode
                  )}`}
                >
                  {planLabel}
                </span>

                <span className="text-white/70">{planDescriptor}</span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/schedule"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                Open Schedule
              </Link>

              <Link
                href="/app/clients"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Open Clients
              </Link>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Clients" value={typedClients.length} icon={Users} />
            <StatCard
              label="Upcoming Lessons"
              value={upcomingAppointments.length}
              icon={CalendarDays}
              subtext="Future non-cancelled appointments"
            />
            <StatCard label="Unread Notifications" value={unreadCount} icon={Bell} />
            <StatCard
              label={isGrowthOrHigher ? "Active Memberships" : "Current Plan"}
              value={isGrowthOrHigher ? activeMembershipsCount : planLabel}
              icon={isGrowthOrHigher ? Sparkles : Layers3}
            />
            <StatCard
              label={isGrowthOrHigher ? "Active Packages" : "Payout Setup"}
              value={isGrowthOrHigher ? activePackagesCount : payoutsReady ? "Ready" : "Pending"}
              icon={isGrowthOrHigher ? ClipboardList : CreditCard}
            />
          </div>
        </div>
      </section>

            {showBillingSetupCard ? (
        <section className="rounded-[32px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-amber-700">
                Billing setup needed
              </p>
              <h2 className="mt-2 text-xl font-semibold text-slate-950">
                Connect billing before taking paid transactions
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Finish billing and payouts setup before relying on paid memberships,
                packages, or future paid event flows.
              </p>
            </div>

            <Link
              href="/app/settings/billing"
              className="inline-flex items-center justify-center rounded-xl bg-amber-600 px-4 py-3 text-sm font-medium text-white hover:bg-amber-700"
            >
              Open Billing &amp; Payouts
            </Link>
          </div>
        </section>
      ) : null}

      <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
        <SectionCard
          title="Studio Snapshot"
          subtitle={
            isGrowthOrHigher
              ? "Day-to-day studio operations for your current plan."
              : "Core CRM and scheduling activity for Starter."
          }
          action={
            <Link
              href="/app/schedule"
              className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
            >
              Open Schedule
            </Link>
          }
        >
          {upcomingAppointments.length === 0 ? (
            <EmptyState>
              No upcoming lessons or appointments yet. Your schedule will start to fill in
              here as bookings are added.
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {upcomingAppointments.slice(0, 6).map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900">
                        {item.title?.trim() || "Appointment"}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {fmtDateTime(item.starts_at)}
                      </p>
                    </div>

                    <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                      {item.status || "scheduled"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <div className="space-y-8">
          <SectionCard
            title={isGrowthOrHigher ? "Growth Features" : "Starter Plan Focus"}
            subtitle={
              isGrowthOrHigher
                ? "Your Growth workspace includes memberships, packages, and payments."
                : "Starter stays focused on CRM, scheduling, and core operations."
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Packages</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {isGrowthOrHigher ? activePackagesCount : "—"}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  {isGrowthOrHigher
                    ? "Active package balances currently in use."
                    : "Available on Growth and Pro."}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Memberships</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {isGrowthOrHigher ? activeMembershipsCount : "—"}
                </p>
                <p className="mt-2 text-sm text-slate-500">
                  {isGrowthOrHigher
                    ? "Active memberships in your current studio."
                    : "Available on Growth and Pro."}
                </p>
              </div>
            </div>

            {!isGrowthOrHigher ? (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-sm leading-7 text-slate-600">
                  Growth adds packages, memberships, and customer payment operations.
                  Pro adds public-event and organizer capabilities on top of that.
                </p>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title="Recent Alerts"
            subtitle="Latest notifications for this workspace."
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
              <EmptyState>No notifications yet.</EmptyState>
            ) : (
              <div className="space-y-3">
                {typedNotifications.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">{item.title}</p>
                        {item.body ? (
                          <p className="mt-1 text-sm text-slate-600">{item.body}</p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-xs text-slate-500">
                        {fmtDateTime(item.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </section>

      {canSeeProEventModule ? (
        <section className="grid gap-8 xl:grid-cols-[1.1fr_0.9fr]">
          <SectionCard
            title="Public Events Module"
            subtitle="Pro includes organizer/public event capabilities as an added module, not the default dashboard identity."
            action={
              <Link
                href="/app/events"
                className="text-sm font-medium text-[var(--brand-primary)] hover:underline"
              >
                Open Events
              </Link>
            }
          >
            {proEvents.length === 0 ? (
              <EmptyState>
                No public events yet. Pro unlocks this module when you are ready to use it.
              </EmptyState>
            ) : (
              <div className="space-y-4">
                {proEvents.slice(0, 4).map((event) => (
                  <div
                    key={event.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-slate-900">{event.name}</h3>
                          <span
                            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                              event.status
                            )}`}
                          >
                            {event.status}
                          </span>
                        </div>

                        <p className="mt-2 text-sm text-slate-500">
                          {fmtDateRange(event.start_date, event.end_date)}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200">
                            {eventTypeLabel(event.event_type)}
                          </span>

                          {event.public_directory_enabled ? (
                            <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700 ring-1 ring-sky-200">
                              Directory On
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <Link
                        href={`/app/events/${event.slug}`}
                        className="inline-flex items-center gap-2 text-sm font-medium text-[var(--brand-primary)] hover:underline"
                      >
                        Open
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Pro Event Snapshot"
            subtitle="This section is only visible on Studio Pro."
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Events</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">{proEvents.length}</p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Registrations</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {proRegistrations.length}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Organizer Profiles</p>
                <p className="mt-2 text-2xl font-semibold text-slate-950">
                  {proOrganizers.filter((item) => item.active).length}
                </p>
              </div>
            </div>
          </SectionCard>
        </section>
      ) : null}
    </div>
  );
}