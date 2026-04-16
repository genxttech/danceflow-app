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
  lesson_recaps:
    | {
        id: string;
        visible_to_client: boolean;
      }[]
    | {
        id: string;
        visible_to_client: boolean;
      }
    | null;
  instructors:
    | {
        id: string;
        full_name: string | null;
      }[]
    | {
        id: string;
        full_name: string | null;
      }
    | null;
};

type RentalSummaryRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  room_id: string | null;
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

function getRecap(value: AppointmentSummaryRow["lesson_recaps"]) {
  return Array.isArray(value) ? value[0] : value;
}

function getInstructorName(value: AppointmentSummaryRow["instructors"]) {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.full_name?.trim() || "Studio staff";
}

function getClientFirstName(client: ClientRow) {
  return client.first_name?.trim() || "there";
}

function CardShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border bg-white p-6 shadow-sm sm:p-8">
      <div className="max-w-2xl">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">{title}</h2>
        {subtitle ? <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p> : null}
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
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const typedStudio = studio as StudioRow;

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email, is_independent_instructor")
    .eq("studio_id", typedStudio.id)
    .eq("auth_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const typedClient = client as ClientRow;

  const nowIso = new Date().toISOString();

  const [
    { data: membership },
    { data: appointments },
    { data: rentals },
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
        title,
        lesson_recaps (
          id,
          visible_to_client
        ),
        instructors (
          id,
          full_name
        )
      `)
      .eq("studio_id", typedStudio.id)
      .eq("client_id", typedClient.id)
      .in("appointment_type", ["private_lesson", "intro_lesson", "group_class"])
      .order("starts_at", { ascending: false })
      .limit(8),

    typedClient.is_independent_instructor
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

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-[2rem] border bg-white shadow-sm">
        <div className="bg-gradient-to-br from-slate-50 via-white to-slate-100 px-6 py-8 sm:px-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-sm font-medium text-slate-500">{typedStudio.name}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                Welcome back, {getClientFirstName(typedClient)}
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                Your portal keeps your upcoming lessons, recaps, and account details in one place.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/portal/${encodeURIComponent(typedStudio.slug)}/profile`}
                className="inline-flex rounded-xl border bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                My Profile
              </Link>
              {typedMembership ? (
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/membership`}
                  className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  View Membership
                </Link>
              ) : null}
              {typedClient.is_independent_instructor ? (
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space`}
                  className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Book Floor Space
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.4fr,0.9fr]">
        <CardShell
          title="My Lessons"
          subtitle="Open a completed private lesson to review your recap, practice notes, and any lesson video your instructor shared."
        >
          {recentLessons.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-slate-50 p-5">
              <p className="text-sm font-medium text-slate-900">No lessons yet</p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Your recent lessons will appear here once they have been added to your account.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {recentLessons.map((appointment) => {
                const recap = getRecap(appointment.lesson_recaps);
                const canViewLesson =
                  appointment.appointment_type === "private_lesson" &&
                  appointment.status === "attended" &&
                  Boolean(recap?.visible_to_client);

                return (
                  <div
                    key={appointment.id}
                    className="rounded-2xl border bg-slate-50 p-5 transition hover:bg-white"
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
                          {canViewLesson ? (
                            <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 ring-1 ring-green-100">
                              Recap Ready
                            </span>
                          ) : null}
                        </div>

                        <p className="mt-2 text-sm text-slate-700">
                          {formatDateTime(appointment.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          With {getInstructorName(appointment.instructors)}
                        </p>
                      </div>

                      <div className="flex shrink-0 flex-wrap gap-2">
                        {canViewLesson ? (
                          <Link
                            href={`/portal/${encodeURIComponent(
                              typedStudio.slug
                            )}/appointments/${appointment.id}`}
                            className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                          >
                            View Lesson
                          </Link>
                        ) : (
                          <span className="inline-flex rounded-xl border bg-white px-4 py-2 text-sm font-medium text-slate-500">
                            {appointment.status === "scheduled"
                              ? "Lesson not completed yet"
                              : "No recap shared"}
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

        <div className="space-y-6">
          <CardShell
            title="Membership"
            subtitle="Your current plan and billing cycle at a glance."
          >
            {!typedMembership ? (
              <div className="rounded-2xl border border-dashed bg-slate-50 p-5">
                <p className="text-sm font-medium text-slate-900">No active membership</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  If your studio offers memberships, details will appear here once one is assigned to your account.
                </p>
              </div>
            ) : (
              <div className="rounded-2xl border bg-slate-50 p-5">
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

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Price
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {formatCurrency(typedMembership.price_snapshot)}{" "}
                      {typedMembership.billing_interval_snapshot
                        ? `/ ${typedMembership.billing_interval_snapshot}`
                        : ""}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Current Period
                    </p>
                    <p className="mt-1 text-sm text-slate-700">
                      {formatDate(typedMembership.current_period_start)} –{" "}
                      {formatDate(typedMembership.current_period_end)}
                    </p>
                  </div>
                </div>

                <div className="mt-4">
                  <Link
                    href={`/portal/${encodeURIComponent(typedStudio.slug)}/membership`}
                    className="inline-flex rounded-xl border bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Membership Details
                  </Link>
                </div>
              </div>
            )}
          </CardShell>

          <CardShell
            title="Coming Up"
            subtitle="Your next scheduled appointments."
          >
            {upcomingAppointments.length === 0 ? (
              <div className="rounded-2xl border border-dashed bg-slate-50 p-5">
                <p className="text-sm font-medium text-slate-900">Nothing upcoming</p>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Upcoming lessons and classes will appear here.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {upcomingAppointments.slice(0, 4).map((appointment) => (
                  <div key={appointment.id} className="rounded-2xl border bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {appointment.title?.trim() ||
                            appointmentTypeLabel(appointment.appointment_type)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(appointment.starts_at)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          With {getInstructorName(appointment.instructors)}
                        </p>
                      </div>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                          appointment.status
                        )}`}
                      >
                        {statusLabel(appointment.status)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardShell>
        </div>
      </div>

      {typedClient.is_independent_instructor ? (
        <CardShell
          title="Floor Space Rentals"
          subtitle="Quick access to book time and review your upcoming rentals."
        >
          <div className="grid gap-6 lg:grid-cols-[0.9fr,1.1fr]">
            <div className="rounded-2xl border bg-slate-50 p-5">
              <p className="text-sm font-medium text-slate-900">Quick links</p>
              <div className="mt-4 grid gap-3">
                <Link
                  href={`/portal/${encodeURIComponent(typedStudio.slug)}/floor-space`}
                  className="inline-flex justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Book Floor Space
                </Link>
                <Link
                  href={`/portal/${encodeURIComponent(
                    typedStudio.slug
                  )}/floor-space/my-rentals`}
                  className="inline-flex justify-center rounded-xl border bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  My Rentals
                </Link>
              </div>
            </div>

            <div className="rounded-2xl border bg-slate-50 p-5">
              <p className="text-sm font-medium text-slate-900">Upcoming rentals</p>
              {typedRentals.length === 0 ? (
                <p className="mt-3 text-sm leading-6 text-slate-600">
                  You do not have any upcoming floor rentals scheduled.
                </p>
              ) : (
                <div className="mt-4 space-y-3">
                  {typedRentals.map((rental) => (
                    <div key={rental.id} className="rounded-2xl border bg-white p-4">
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
    </div>
  );
}
