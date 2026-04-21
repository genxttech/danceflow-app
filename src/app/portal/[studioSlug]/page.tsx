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
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
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

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;
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
    <div className="space-y-8">
      <section className="rounded-[36px] border border-slate-200 bg-white p-8 shadow-sm md:p-10">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              {isInstructorPortal ? "Instructor Portal" : "Client Portal"}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
              Welcome back, {getClientFirstName(typedClient)}.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-8 text-slate-600">
              {isInstructorPortal
                ? "Your instructor portal gives you a studio-specific workspace for your schedule, floor rentals, lesson access, and any linked client billing tools."
                : "Your client portal gives you a simple home base for memberships, lesson activity, and upcoming appointments at your studio."}
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              {isInstructorPortal ? (
                <>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                    className="rounded-2xl bg-[var(--brand-accent-dark)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                  >
                    My Schedule
                  </Link>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/book`}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Book Floor Space
                  </Link>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    My Rentals
                  </Link>
                </>
              ) : (
                <>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/appointments`}
                    className="rounded-2xl bg-[var(--brand-accent-dark)] px-4 py-3 text-sm font-medium text-white hover:opacity-95"
                  >
                    My Appointments
                  </Link>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/memberships`}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Memberships
                  </Link>
                </>
              )}
            </div>
          </div>

          <div className="grid w-full max-w-xl grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                {isInstructorPortal ? "My Schedule" : "Upcoming Appointments"}
              </p>
              <p className="mt-3 text-3xl font-semibold text-slate-950">{upcomingCount}</p>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Active Membership
              </p>
              <p className="mt-3 text-lg font-semibold text-slate-950">
                {typedMembership ? typedMembership.name_snapshot : "None"}
              </p>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-slate-50/70 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Studio
              </p>
              <p className="mt-3 text-lg font-semibold text-slate-950">{studioLabel}</p>
            </div>
          </div>
        </div>
      </section>

      {isInstructorPortal ? (
        <CardShell
          title="Instructor Actions"
          accent="sky"
          subtitle="Go straight to the tools you use most as an independent instructor."
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
              className="rounded-2xl border border-sky-200 bg-sky-50 p-5 hover:bg-sky-100"
            >
              <p className="font-medium text-slate-900">My Schedule</p>
              <p className="mt-1 text-sm text-slate-600">
                View your upcoming rentals, lessons, and recent schedule history.
              </p>
            </Link>

            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/book`}
              className="rounded-2xl border border-orange-200 bg-orange-50 p-5 hover:bg-orange-100"
            >
              <p className="font-medium text-slate-900">Book Floor Space</p>
              <p className="mt-1 text-sm text-slate-600">
                Reserve floor time for your lessons and teaching schedule.
              </p>
            </Link>

            <Link
              href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
              className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 hover:bg-emerald-100"
            >
              <p className="font-medium text-slate-900">My Rentals</p>
              <p className="mt-1 text-sm text-slate-600">
                Review your rentals, unpaid balance, and payment history.
              </p>
            </Link>
          </div>
        </CardShell>
      ) : null}

      <div className="grid gap-8 xl:grid-cols-[1.25fr_0.95fr]">
        <div className="space-y-8">
          <CardShell
            title={isInstructorPortal ? "Instructor Workspace" : "Membership Snapshot"}
            accent={isInstructorPortal ? "sky" : "violet"}
            subtitle={
              isInstructorPortal
                ? "A lightweight workspace built around your teaching and rental tasks."
                : "Your current recurring membership status and billing period."
            }
          >
            {isInstructorPortal ? (
              <div className="space-y-5">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm font-medium text-slate-900">Quick links</p>
                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/schedule`}
                      className="rounded-2xl bg-slate-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-slate-800"
                    >
                      My Schedule
                    </Link>
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/book`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Book Floor Space
                    </Link>
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space/my-rentals`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      My Rentals
                    </Link>
                  </div>
                </div>

                {typedMembership ? (
                  <div className="rounded-3xl border border-violet-200 bg-violet-50 p-5">
                    <p className="text-sm font-medium text-slate-900">Linked client membership</p>
                    <p className="mt-2 text-lg font-semibold text-slate-950">
                      {typedMembership.name_snapshot}
                    </p>
                    <p className="mt-2 text-sm text-slate-600">
                      {formatCurrency(typedMembership.price_snapshot)} /{" "}
                      {typedMembership.billing_interval_snapshot || "period"}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-5">
                    <p className="text-sm text-slate-600">
                      No client membership is currently linked to this portal account.
                    </p>
                  </div>
                )}
              </div>
            ) : typedMembership ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Plan</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {typedMembership.name_snapshot}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    {formatCurrency(typedMembership.price_snapshot)} /{" "}
                    {typedMembership.billing_interval_snapshot || "period"}
                  </p>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <p className="text-sm text-slate-500">Status</p>
                  <p className="mt-2 text-xl font-semibold text-slate-950">
                    {statusLabel(typedMembership.status)}
                  </p>
                  <p className="mt-2 text-sm text-slate-600">
                    Current period: {formatDate(typedMembership.current_period_start)} –{" "}
                    {formatDate(typedMembership.current_period_end)}
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
                  No active membership is linked to your client profile right now.
                </p>
              </div>
            )}
          </CardShell>

          <CardShell
            title={isInstructorPortal ? "Recent Lesson Activity" : "Recent Appointments"}
            accent="emerald"
            subtitle={
              isInstructorPortal
                ? "Your recent lesson-side appointment history linked to your client profile."
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
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(
                          item.status
                        )}`}
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
            title="My Schedule"
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your next upcoming lessons and rentals in one place."
                : "Your upcoming appointment activity."
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
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(
                          item.status
                        )}`}
                      >
                        {statusLabel(item.status)}
                      </span>

                      <span className="inline-flex rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        {item.kind === "rental" ? "Rental" : "Lesson"}
                      </span>
                    </div>

                    <p className="mt-3 font-medium text-slate-950">{item.title}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatDateTime(item.starts_at)}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      {formatTimeRange(item.starts_at, item.ends_at)}
                    </p>
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
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClass(
                              item.status
                            )}`}
                          >
                            {statusLabel(item.status)}
                          </span>
                        </div>
                        <p className="mt-3 font-medium text-slate-950">Floor Space Rental</p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(item.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {formatTimeRange(item.starts_at, item.ends_at)}
                        </p>
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
