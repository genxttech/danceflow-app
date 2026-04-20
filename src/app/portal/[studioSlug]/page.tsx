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
    throw new Error(`Failed to load portal appointments: ${appointmentsError.message}`);
  }

  if (rentalsError) {
    throw new Error(`Failed to load portal rentals: ${rentalsError.message}`);
  }

  const typedMembership = (membership ?? null) as ActiveMembership | null;
  const typedAppointments = (appointments ?? []) as AppointmentSummaryRow[];
  const typedRentals = (rentals ?? []) as RentalSummaryRow[];

  const recentLessons = typedAppointments.filter(
    (appointment) =>
      appointment.appointment_type === "private_lesson" ||
      appointment.appointment_type === "intro_lesson"
  );

  const upcomingAppointments = typedAppointments.filter(
    (appointment) =>
      appointment.status === "scheduled" && new Date(appointment.starts_at) >= new Date()
  );

  const upcomingItems: UpcomingItem[] = [
    ...upcomingAppointments.map((appointment) => ({
      id: appointment.id,
      kind: "appointment" as const,
      starts_at: appointment.starts_at,
      ends_at: appointment.ends_at,
      status: appointment.status,
      title:
        appointment.title?.trim() ||
        appointmentTypeLabel(appointment.appointment_type),
    })),
    ...typedRentals.map((rental) => ({
      id: rental.id,
      kind: "rental" as const,
      starts_at: rental.starts_at,
      ends_at: rental.ends_at,
      status: rental.status,
      title: "Floor Space Rental",
    })),
  ]
    .sort(
      (a, b) =>
        new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    )
    .slice(0, 6);

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-[linear-gradient(135deg,#fff7ed_0%,#ffffff_42%,#f8fafc_100%)] p-8 shadow-sm sm:p-10">
        <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-600">
              {studioLabel}
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Hi, {getClientFirstName(typedClient)}
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
              {isInstructorPortal
                ? "Your instructor portal gives you a studio-specific workspace for floor rentals, your upcoming schedule, lesson access, and any linked client billing tools."
                : "Your studio portal keeps lessons, memberships, recaps, rentals, and studio-specific access in one place while your public favorites and event registrations remain in your main account."}
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-orange-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">
                  {isInstructorPortal ? "Upcoming Schedule Items" : "Upcoming Appointments"}
                </p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {isInstructorPortal ? upcomingItems.length : upcomingAppointments.length}
                </p>
              </div>

              <div className="rounded-2xl border border-violet-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">
                  {isInstructorPortal ? "Recent Lessons" : "Recent Lessons"}
                </p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {recentLessons.length}
                </p>
              </div>

              <div className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">
                  {isInstructorPortal ? "Upcoming Rentals" : "Portal Access"}
                </p>
                <p className="mt-2 text-xl font-semibold text-slate-950">
                  {isInstructorPortal
                    ? typedRentals.length
                    : "Client"}
                </p>
              </div>

              <div className="rounded-2xl border border-sky-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">
                  {isInstructorPortal ? "Portal Access" : "Membership"}
                </p>
                <p className="mt-2 text-xl font-semibold text-slate-950">
                  {isInstructorPortal
                    ? "Independent Instructor"
                    : typedMembership
                      ? "Active"
                      : "None"}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              {isInstructorPortal ? "Instructor Actions" : "Portal Actions"}
            </p>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">My Profile</p>
                <p className="mt-1 text-sm text-slate-600">
                  Review your contact details and studio-linked portal access.
                </p>
              </Link>

              {typedMembership ? (
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/membership`}
                  className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
                >
                  <p className="font-medium text-slate-900">Membership Details</p>
                  <p className="mt-1 text-sm text-slate-600">
                    View your active plan, billing period, and membership status.
                  </p>
                </Link>
              ) : null}

              {isInstructorPortal ? (
                <>
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space`}
                    className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 hover:bg-emerald-100"
                  >
                    <p className="font-medium text-slate-900">Book Floor Space</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Reserve studio time and manage rental bookings.
                    </p>
                  </Link>

                  <Link
                    href={`/portal/${encodeURIComponent(
                      typedStudio.slug
                    )}/floor-space/my-rentals`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
                  >
                    <p className="font-medium text-slate-900">My Rentals</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Review your upcoming rentals and recent rental activity.
                    </p>
                  </Link>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.35fr_0.85fr]">
        <div className="space-y-8">
          {isInstructorPortal ? (
            <CardShell
              title="Instructor Workspace"
              accent="emerald"
              subtitle="Everything you need most often as an independent instructor from this studio portal."
            >
              <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Quick links</p>
                  <div className="mt-4 grid gap-3">
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space`}
                      className="rounded-2xl bg-slate-900 px-4 py-3 text-center text-sm font-medium text-white hover:bg-slate-800"
                    >
                      Book Floor Space
                    </Link>
                    <Link
                      href={`/portal/${encodeURIComponent(
                        typedStudio.slug
                      )}/floor-space/my-rentals`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      My Rentals
                    </Link>
                    <Link
                      href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                      className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      My Profile
                    </Link>
                  </div>
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm">
                  <p className="text-sm font-medium text-slate-900">Upcoming rentals</p>
                  {typedRentals.length === 0 ? (
                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      You do not have any upcoming floor rentals scheduled.
                    </p>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {typedRentals.map((rental) => (
                        <div
                          key={rental.id}
                          className="rounded-2xl border border-slate-200 bg-white p-4"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-semibold text-slate-900">
                                {formatDateTime(rental.starts_at)}
                              </p>
                              <p className="mt-1 text-sm text-slate-600">
                                {formatTimeRange(rental.starts_at, rental.ends_at)}
                              </p>
                            </div>
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                                rental.status
                              )}`}
                            >
                              {statusLabel(rental.status)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CardShell>
          ) : null}

          <CardShell
            title={isInstructorPortal ? "My Lessons & Studio Activity" : "My Lessons"}
            accent="violet"
            subtitle={
              isInstructorPortal
                ? "Review your completed lessons and other studio-linked activity available through this portal."
                : "Review your completed lessons and open the lesson detail page for recap information your studio has shared."
            }
          >
            {recentLessons.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">No lessons yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Your recent lessons will appear here once they have been added to your account.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {recentLessons.map((appointment) => {
                  const canViewLesson =
                    (appointment.appointment_type === "private_lesson" ||
                      appointment.appointment_type === "intro_lesson") &&
                    appointment.status === "attended";

                  return (
                    <div
                      key={appointment.id}
                      className="rounded-3xl border border-slate-200 bg-slate-50 p-6 shadow-sm transition hover:bg-white"
                    >
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-semibold text-slate-900">
                              {appointment.title?.trim() ||
                                appointmentTypeLabel(appointment.appointment_type)}
                            </span>
                            <span
                              className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                                appointment.status
                              )}`}
                            >
                              {statusLabel(appointment.status)}
                            </span>
                          </div>

                          <p className="mt-3 text-sm text-slate-700">
                            {formatDateTime(appointment.starts_at)}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-wrap gap-2">
                          {canViewLesson ? (
                            <Link
                              href={`/portal/${encodeURIComponent(
                                typedStudio.slug
                              )}/appointments/${appointment.id}`}
                              className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                            >
                              View Lesson
                            </Link>
                          ) : (
                            <span className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-500">
                              {appointment.status === "scheduled"
                                ? "Lesson not completed yet"
                                : "Lesson details unavailable"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardShell>
        </div>

        <div className="space-y-8">
          {typedMembership ? (
            <CardShell
              title="Membership"
              accent="emerald"
              subtitle="Your current plan and billing cycle at a glance."
            >
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">
                    {typedMembership.name_snapshot}
                  </h3>
                  <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 ring-1 ring-green-100">
                    {typedMembership.status.replaceAll("_", " ")}
                  </span>
                  {typedMembership.cancel_at_period_end ? (
                    <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-100">
                      Ends This Period
                    </span>
                  ) : null}
                </div>

                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-2xl border border-white/80 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Price
                    </p>
                    <p className="mt-2 text-sm text-slate-700">
                      {formatCurrency(typedMembership.price_snapshot)}{" "}
                      {typedMembership.billing_interval_snapshot
                        ? `/ ${typedMembership.billing_interval_snapshot}`
                        : ""}
                    </p>
                  </div>

                  <div className="rounded-2xl border border-white/80 bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Current Period
                    </p>
                    <p className="mt-2 text-sm text-slate-700">
                      {formatDate(typedMembership.current_period_start)} –{" "}
                      {formatDate(typedMembership.current_period_end)}
                    </p>
                  </div>
                </div>

                <div className="mt-5">
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/membership`}
                    className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Membership Details
                  </Link>
                </div>
              </div>
            </CardShell>
          ) : null}

          <CardShell
            title={isInstructorPortal ? "My Schedule" : "Coming Up"}
            accent="sky"
            subtitle={
              isInstructorPortal
                ? "Your next rentals and studio-linked appointments."
                : "Your next scheduled appointments."
            }
          >
            {upcomingItems.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center">
                <p className="text-lg font-medium text-slate-900">
                  {isInstructorPortal ? "Nothing scheduled" : "Nothing upcoming"}
                </p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {isInstructorPortal
                    ? "Upcoming rentals and appointments will appear here."
                    : "Upcoming lessons and classes will appear here."}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {upcomingItems.map((item) => (
                  <div
                    key={`${item.kind}-${item.id}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {item.title}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(item.starts_at)}
                        </p>
                        {item.kind === "rental" ? (
                          <p className="mt-1 text-xs font-medium uppercase tracking-[0.14em] text-emerald-700">
                            Floor Rental
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                          item.status
                        )}`}
                      >
                        {statusLabel(item.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardShell>

          <CardShell
            title="Portal Notes"
            accent="orange"
            subtitle="A few reminders about how this studio portal fits into your account."
          >
            <div className="rounded-3xl border border-orange-100 bg-orange-50 p-6 shadow-sm">
              <ul className="space-y-3 text-sm leading-7 text-slate-700">
                <li>Your favorites and public event registrations stay in your main account.</li>
                <li>
                  This portal is your studio-specific space for
                  {isInstructorPortal
                    ? " rentals, schedule access, lessons, and linked membership details."
                    : " lessons, memberships, recaps, and studio-specific access."}
                </li>
                <li>If a studio links additional access later, it will appear in your account without replacing this login.</li>
              </ul>
            </div>
          </CardShell>
        </div>
      </div>
    </div>
  );
}
