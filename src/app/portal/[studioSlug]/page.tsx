import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  studioSlug: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_name: string | null;
};

type ClientRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  is_independent_instructor: boolean | null;
};

type ActiveMembership = {
  id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number | null;
  billing_interval_snapshot: string | null;
};

type AppointmentSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  title: string | null;
};

type RentalSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  room_id: string | null;
};

type UpcomingItem = {
  id: string;
  kind: "appointment" | "rental";
  starts_at: string;
  ends_at: string;
  status: string;
  title: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatTimeRange(start: string, end: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${fmt.format(new Date(start))} – ${fmt.format(new Date(end))}`;
}

function appointmentTypeLabel(value: string) {
  if (value === "private_lesson") return "Private Lesson";
  if (value === "group_class") return "Group Class";
  if (value === "intro_lesson") return "Intro Lesson";
  if (value === "floor_space_rental") return "Floor Space Rental";
  if (value === "party") return "Party";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusLabel(value: string) {
  if (value === "scheduled") return "Scheduled";
  if (value === "attended") return "Completed";
  if (value === "cancelled") return "Cancelled";
  if (value === "no_show") return "Missed";
  if (value === "active") return "Active";
  if (value === "trialing") return "Trial";
  if (value === "past_due") return "Past Due";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  if (status === "active") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (status === "trialing") return "bg-violet-50 text-violet-700 ring-1 ring-violet-100";
  if (status === "past_due") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function getClientFirstName(client: ClientRow) {
  return client.first_name?.trim() || "there";
}

function CardShell({
  title,
  subtitle,
  accent = "slate",
  children,
}: {
  title: string;
  subtitle?: string;
  accent?: "slate" | "orange" | "emerald" | "violet" | "sky";
  children: React.ReactNode;
}) {
  const accentMap: Record<string, string> = {
    slate: "text-slate-500",
    orange: "text-orange-600",
    emerald: "text-emerald-700",
    violet: "text-violet-700",
    sky: "text-sky-700",
  };

  return (
    <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
      <div className="max-w-2xl">
        <p className={`text-sm font-semibold uppercase tracking-[0.16em] ${accentMap[accent]}`}>
          {title}
        </p>
        {subtitle ? (
          <p className="mt-3 text-sm leading-7 text-slate-600">{subtitle}</p>
        ) : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function ActionTile({
  href,
  title,
  description,
  tone = "slate",
}: {
  href: string;
  title: string;
  description: string;
  tone?: "slate" | "sky" | "orange" | "emerald" | "violet";
}) {
  const classes: Record<string, string> = {
    slate: "border-slate-200 bg-slate-50 hover:bg-slate-100",
    sky: "border-sky-200 bg-sky-50 hover:bg-sky-100",
    orange: "border-orange-200 bg-orange-50 hover:bg-orange-100",
    emerald: "border-emerald-200 bg-emerald-50 hover:bg-emerald-100",
    violet: "border-violet-200 bg-violet-50 hover:bg-violet-100",
  };

  return (
    <Link href={href} className={`rounded-2xl border p-5 transition ${classes[tone]}`}>
      <p className="font-medium text-slate-900">{title}</p>
      <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
    </Link>
  );
}

export default async function PortalHomePage({
  params,
}: {
  params: Params;
}) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;
  const studioLabel = typedStudio.public_name?.trim() || typedStudio.name;

  let typedClient: ClientRow | null = null;

  const { data: linkedClient, error: linkedClientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (linkedClientError) {
    throw linkedClientError;
  }

  if (linkedClient) {
    typedClient = linkedClient as ClientRow;
  } else if (user.email) {
    const { data: emailMatchedClient, error: emailMatchedClientError } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, is_independent_instructor")
      .eq("studio_id", typedStudio.id)
      .eq("email", user.email)
      .eq("is_independent_instructor", true)
      .maybeSingle();

    if (emailMatchedClientError) {
      throw emailMatchedClientError;
    }

    if (emailMatchedClient) {
      const { error: linkError } = await supabase
        .from("clients")
        .update({ portal_user_id: user.id })
        .eq("id", emailMatchedClient.id)
        .eq("studio_id", typedStudio.id);

      if (linkError) {
        throw linkError;
      }

      typedClient = emailMatchedClient as ClientRow;
    }
  }

  if (!typedClient) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: workspaceRole, error: workspaceRoleError } = await supabase
    .from("user_studio_roles")
    .select("role, active")
    .eq("studio_id", typedStudio.id)
    .eq("user_id", user.id)
    .eq("active", true)
    .maybeSingle();

  if (workspaceRoleError) {
    throw workspaceRoleError;
  }

  const canReturnToWorkspace = Boolean(workspaceRole);

  const isInstructorPortal = Boolean(typedClient.is_independent_instructor);
  const nowIso = new Date().toISOString();

  const [
    { data: membership },
    { data: appointments, error: appointmentsError },
    { data: rentals, error: rentalsError },
  ] = await Promise.all([
    supabase
      .from("client_memberships")
      .select(`
        id,
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot
      `)
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("status", ["active", "trialing", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("appointments")
      .select(`
        id,
        starts_at,
        ends_at,
        status,
        appointment_type,
        title
      `)
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("appointment_type", ["private_lesson", "intro_lesson", "group_class"])
      .order("starts_at", { ascending: false })
      .limit(8),

    isInstructorPortal
      ? supabase
          .from("appointments")
          .select("id, starts_at, ends_at, status, room_id")
          .eq("studio_id", typedStudio.id)
          .eq("client_id", typedClient.id)
          .eq("appointment_type", "floor_space_rental")
          .gte("starts_at", nowIso)
          .order("starts_at", { ascending: true })
          .limit(5)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (appointmentsError) {
    throw appointmentsError;
  }

  if (rentalsError) {
    throw rentalsError;
  }

  const typedMembership = (membership ?? null) as ActiveMembership | null;
  const typedAppointments = (appointments ?? []) as AppointmentSummaryRow[];
  const typedRentals = (rentals ?? []) as RentalSummaryRow[];

  const upcomingAppointments = typedAppointments
    .filter((item) => item.starts_at >= nowIso)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 5);

  const recentAppointments = typedAppointments
    .filter((item) => item.starts_at < nowIso)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 5);

  const upcomingItems: UpcomingItem[] = [
    ...upcomingAppointments.map((item) => ({
      id: item.id,
      kind: "appointment" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: item.title?.trim() || appointmentTypeLabel(item.appointment_type),
    })),
    ...typedRentals.map((item) => ({
      id: item.id,
      kind: "rental" as const,
      starts_at: item.starts_at,
      ends_at: item.ends_at,
      status: item.status,
      title: "Floor Space Rental",
    })),
  ]
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
    .slice(0, 6);

  const upcomingCount = isInstructorPortal
    ? upcomingItems.length
    : upcomingAppointments.length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.42)_0%,rgba(255,255,255,0)_24%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  {isInstructorPortal ? "DanceFlow Instructor Portal" : "DanceFlow Client Portal"}
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                  Welcome back, {getClientFirstName(typedClient)}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  {isInstructorPortal
                    ? "Use this page to see your schedule, manage floor rentals, and get to the tools you use most."
                    : "Use this page to check your upcoming appointments, view your membership, and stay on top of your studio activity."}
                </p>
                <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                  <span>
                    Studio: <span className="font-medium text-white">{studioLabel}</span>
                  </span>
                  <span>
                    Portal:{" "}
                    <span className="font-medium text-white">
                      {isInstructorPortal ? "Independent Instructor" : "Client"}
                    </span>
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                {canReturnToWorkspace ? (
                  <Link
                    href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Back to Workspace
                  </Link>
                ) : null}
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                >
                  My Account
                </Link>

                <form action="/auth/logout" method="post">
  <button
    type="submit"
    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
  >
    Log Out
  </button>
</form>
              </div>
            </div>

            <div className="grid w-full gap-4 md:grid-cols-3">
              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  {isInstructorPortal ? "Coming Up" : "Upcoming Appointments"}
                </p>
                <p className="mt-3 text-3xl font-semibold text-white">{upcomingCount}</p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Active Membership
                </p>
                <p className="mt-3 text-lg font-semibold text-white">
                  {typedMembership ? typedMembership.name_snapshot : "None"}
                </p>
              </div>

              <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/75">
                  Studio
                </p>
                <p className="mt-3 text-lg font-semibold text-white">{studioLabel}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                {isInstructorPortal ? "See your schedule quickly" : "See your appointments quickly"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                {isInstructorPortal
                  ? "Check your upcoming lessons and floor rentals without digging through extra pages."
                  : "Check your upcoming lessons and class bookings in one place."}
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                {isInstructorPortal ? "Use the links you need most" : "Keep your membership in view"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                {isInstructorPortal
                  ? "Jump straight to your schedule, booking floor space, or reviewing your rentals."
                  : "See your current membership details and know what is active right now."}
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                {isInstructorPortal ? "Stay on top of rentals" : "Stay ready for your next visit"}
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                {isInstructorPortal
                  ? "Review rental dates, payment activity, and what is coming up next."
                  : "Use your portal to keep track of upcoming appointments and recent studio activity."}
              </p>
            </div>
          </div>
        </div>
      </section>

      <CardShell
        title="Quick Actions"
        accent="sky"
        subtitle={
          isInstructorPortal
            ? "Use these links to move between your schedule, rentals, account details, and workspace access."
            : "Use these links to move between your schedule, account details, and membership tools."
        }
      >
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}`}
            title="Portal Home"
            description="Return to your main portal dashboard."
            tone="slate"
          />
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
            title="My Schedule"
            description="See upcoming lessons and recent activity."
            tone="sky"
          />
          {isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(studioSlug)}/floor-space`}
              title="Book Floor Space"
              description="Reserve time for teaching and rentals."
              tone="orange"
            />
          ) : null}
          {isInstructorPortal ? (
            <ActionTile
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
              title="My Rentals"
              description="Review rentals, payments, and balances."
              tone="emerald"
            />
          ) : null}
          <ActionTile
            href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
            title="My Account"
            description="Update your profile and account details."
            tone="violet"
          />
          {canReturnToWorkspace ? (
            <ActionTile
              href={`/app?studio=${encodeURIComponent(typedStudio.id)}`}
              title="Back to Workspace"
              description="Return to the full staff workspace for this studio."
              tone="slate"
            />
          ) : null}
        </div>
      </CardShell>

      <div className="grid gap-8 xl:grid-cols-[1.25fr_0.95fr]">
        <div className="space-y-8">
          <CardShell
            title={isInstructorPortal ? "My Membership" : "Membership Snapshot"}
            accent="violet"
            subtitle={
              isInstructorPortal
                ? "If this portal account also has a membership, you can review it here."
                : "See your current membership and billing period in one place."
            }
          >
            {typedMembership ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Plan</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {typedMembership.name_snapshot}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {formatCurrency(typedMembership.price_snapshot)} / {typedMembership.billing_interval_snapshot || "period"}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Status</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {statusLabel(typedMembership.status)}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Current period: {formatDate(typedMembership.current_period_start)} – {formatDate(typedMembership.current_period_end)}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5 md:col-span-2">
                  <p className="text-sm text-slate-500">Renewal</p>
                  <p className="mt-2 text-sm text-slate-700">
                    {typedMembership.cancel_at_period_end
                      ? "Your membership will end at the close of the current billing period."
                      : typedMembership.auto_renew
                        ? "Your membership is set to renew automatically."
                        : "Auto-renew is currently turned off."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">
                  No active membership is linked to this portal profile right now.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title={isInstructorPortal ? "Recent Lesson Activity" : "Recent Appointments"}
            accent="emerald"
            subtitle={
              isInstructorPortal
                ? "A quick look at your recent lesson-side activity."
                : "A quick look at your most recent lessons and class bookings."
            }
          >
            {recentAppointments.length ? (
              <div className="space-y-3">
                {recentAppointments.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-slate-50 p-5 md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="font-medium text-slate-950">
                        {item.title?.trim() || appointmentTypeLabel(item.appointment_type)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {formatDateTime(item.starts_at)}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No recent appointment history yet.</p>
              </div>
            )}
          </CardShell>
        </div>

        <div className="space-y-8">
          <CardShell
            title="Coming Up"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your next lessons and rentals in one place."
                : "Your upcoming appointments at a glance."
            }
          >
            {upcomingItems.length ? (
              <div className="space-y-3">
                {upcomingItems.map((item) => (
                  <div
                    key={`${item.kind}-${item.id}`}
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                      >
                        {statusLabel(item.status)}
                      </span>

                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {item.kind === "rental" ? "Rental" : "Lesson"}
                      </span>
                    </div>

                    <p className="mt-3 font-medium text-slate-950">{item.title}</p>
                    <p className="mt-1 text-sm text-slate-600">{formatDateTime(item.starts_at)}</p>
                    <p className="mt-1 text-sm text-slate-500">{formatTimeRange(item.starts_at, item.ends_at)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                <p className="text-sm text-slate-600">No upcoming schedule items right now.</p>
              </div>
            )}

            <div className="mt-5">
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Open Full Schedule
              </Link>
            </div>
          </CardShell>

          {isInstructorPortal ? (
            <CardShell
              title="Floor Rentals"
              accent="orange"
              subtitle="Manage your floor rental activity and keep your balance current."
            >
              <div className="space-y-5">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-500">Upcoming rentals</p>
                      <p className="mt-2 text-3xl font-semibold text-slate-950">
                        {typedRentals.length}
                      </p>
                    </div>

                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      View Rentals
                    </Link>
                  </div>
                </div>

                {typedRentals.length ? (
                  <div className="space-y-3">
                    {typedRentals.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(item.status)}`}
                          >
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <p className="mt-3 font-medium text-slate-950">Floor Space Rental</p>
                        <p className="mt-1 text-sm text-slate-600">{formatDateTime(item.starts_at)}</p>
                        <p className="mt-1 text-sm text-slate-500">{formatTimeRange(item.starts_at, item.ends_at)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-6">
                    <p className="text-sm text-slate-600">
                      You do not have any upcoming rentals booked.
                    </p>
                  </div>
                )}
              </div>
            </CardShell>
          ) : null}
        </div>
      </div>
    </div>
  );
}



