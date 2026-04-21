import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PageProps = {
  params: Promise<{
    studioSlug: string;
  }>;
};

type CalendarRow = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  appointment_type: string;
  client_id: string | null;
  instructor_id: string | null;
  room_id: string | null;
  clients:
    | {
        first_name: string;
        last_name: string;
      }
    | {
        first_name: string;
        last_name: string;
      }[]
    | null;
  rooms:
    | {
        name: string;
      }
    | {
        name: string;
      }[]
    | null;
};

function getSingle<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
    | undefined
) {
  const client = getSingle(value);
  if (!client) return "No client";
  return `${client.first_name} ${client.last_name}`;
}

function getRoomName(
  value:
    | { name: string }
    | { name: string }[]
    | null
    | undefined
) {
  const room = getSingle(value);
  return room?.name ?? "No room";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatTimeRange(start: string, end: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
}

function formatStatusLabel(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-green-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-red-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-amber-100";
  if (status === "rescheduled") return "bg-purple-50 text-purple-700 ring-purple-100";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function typeBadgeClass(type: string) {
  if (type === "floor_space_rental") {
    return "bg-indigo-50 text-indigo-700 ring-indigo-100";
  }
  if (type === "private_lesson") {
    return "bg-slate-100 text-slate-700 ring-slate-200";
  }
  if (type === "group_class") {
    return "bg-green-50 text-green-700 ring-green-100";
  }
  if (type === "intro_lesson") {
    return "bg-cyan-50 text-cyan-700 ring-cyan-100";
  }
  if (type === "coaching") {
    return "bg-purple-50 text-purple-700 ring-purple-100";
  }
  if (type === "practice_party") {
    return "bg-amber-50 text-amber-700 ring-amber-100";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function typeLabel(type: string) {
  if (type === "floor_space_rental") return "Floor Rental";
  if (type === "private_lesson") return "Private Lesson";
  if (type === "group_class") return "Group Class";
  if (type === "intro_lesson") return "Intro Lesson";
  if (type === "coaching") return "Coaching";
  if (type === "practice_party") return "Practice Party";
  if (type === "event") return "Event";
  return type.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function groupByDay(rows: CalendarRow[]) {
  const grouped = new Map<string, CalendarRow[]>();

  for (const row of rows) {
    const key = row.starts_at.slice(0, 10);
    const current = grouped.get(key) ?? [];
    current.push(row);
    grouped.set(key, current);
  }

  return Array.from(grouped.entries()).map(([date, items]) => ({
    date,
    items: items.sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
  }));
}

function ScheduleCard({
  item,
  studioSlug,
}: {
  item: CalendarRow;
  studioSlug: string;
}) {
  const isRental = item.appointment_type === "floor_space_rental";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusBadgeClass(
                item.status
              )}`}
            >
              {formatStatusLabel(item.status)}
            </span>
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${typeBadgeClass(
                item.appointment_type
              )}`}
            >
              {typeLabel(item.appointment_type)}
            </span>
          </div>

          <h3 className="mt-3 text-base font-semibold text-slate-900">
            {item.title || typeLabel(item.appointment_type)}
          </h3>

          <p className="mt-1 text-sm text-slate-600">
            {formatTimeRange(item.starts_at, item.ends_at)}
          </p>

          <div className="mt-2 space-y-1 text-sm text-slate-500">
            <p>Client: {getClientName(item.clients)}</p>
            <p>Room: {getRoomName(item.rooms)}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isRental ? (
            <Link
              href={`/portal/${studioSlug}/floor-space/my-rentals`}
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              View Rentals
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default async function PortalSchedulePage({ params }: PageProps) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/portal/${studioSlug}/schedule`)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (studioError || !studio) {
    notFound();
  }

  const { data: portalClient, error: portalClientError } = await supabase
    .from("clients")
    .select(`
      id,
      first_name,
      last_name,
      studio_id,
      is_independent_instructor,
      linked_instructor_id
    `)
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .maybeSingle();

  if (portalClientError || !portalClient) {
    redirect(`/portal/${studioSlug}`);
  }

  if (!portalClient.is_independent_instructor) {
    redirect(`/portal/${studioSlug}`);
  }

  const filters = [
    `client_id.eq.${portalClient.id}`,
    portalClient.linked_instructor_id
      ? `instructor_id.eq.${portalClient.linked_instructor_id}`
      : null,
  ].filter(Boolean) as string[];

  const { data: rawAppointments, error: appointmentsError } = await supabase
    .from("appointments")
    .select(`
      id,
      title,
      starts_at,
      ends_at,
      status,
      appointment_type,
      client_id,
      instructor_id,
      room_id,
      clients:clients!client_id(first_name, last_name),
      rooms:rooms!room_id(name)
    `)
    .eq("studio_id", studio.id)
    .or(filters.join(","))
    .order("starts_at", { ascending: true });

  if (appointmentsError) {
    throw new Error(appointmentsError.message);
  }

  const dedupedMap = new Map<string, CalendarRow>();
  for (const row of (rawAppointments ?? []) as CalendarRow[]) {
    dedupedMap.set(row.id, row);
  }

  const appointments = Array.from(dedupedMap.values()).sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at)
  );

  const now = new Date();
  const upcoming = appointments.filter((row) => new Date(row.ends_at) >= now);
  const recent = appointments
    .filter((row) => new Date(row.ends_at) < now)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 20);

  const upcomingGroups = groupByDay(upcoming);
  const recentGroups = groupByDay(recent);

  const unpaidRentalCount = appointments.filter(
    (row) =>
      row.appointment_type === "floor_space_rental" &&
      row.status !== "cancelled" &&
      new Date(row.ends_at) < now
  ).length;

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Instructor Portal
            </p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
              My Schedule
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              View upcoming lessons, rentals, and recent schedule history for {studio.name}.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                Upcoming
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{upcoming.length}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                Recent
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{recent.length}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                Rental Items
              </p>
              <p className="mt-1 text-2xl font-semibold text-slate-900">{unpaidRentalCount}</p>
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={`/portal/${studioSlug}`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Portal
          </Link>

          <Link
            href={`/portal/${studioSlug}/floor-space/book`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Book Floor Space
          </Link>

          <Link
            href={`/portal/${studioSlug}/floor-space/my-rentals`}
            className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-accent-dark)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
          >
            My Rentals
          </Link>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Upcoming Schedule</h2>
            <p className="mt-1 text-sm text-slate-500">
              Future lessons, rentals, and instructor-linked appointments.
            </p>
          </div>
        </div>

        {upcomingGroups.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-slate-600">No upcoming schedule items.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            {upcomingGroups.map((group) => (
              <div key={group.date}>
                <div className="mb-3 flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {formatDate(group.date)}
                  </h3>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>

                <div className="space-y-3">
                  {group.items.map((item) => (
                    <ScheduleCard
                      key={item.id}
                      item={item}
                      studioSlug={studioSlug}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Recent Schedule History</h2>
            <p className="mt-1 text-sm text-slate-500">
              Your most recent completed, cancelled, and past rental items.
            </p>
          </div>
        </div>

        {recentGroups.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
            <p className="text-sm font-medium text-slate-600">No recent schedule history.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-6">
            {recentGroups.map((group) => (
              <div key={group.date}>
                <div className="mb-3 flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {formatDate(group.date)}
                  </h3>
                  <div className="h-px flex-1 bg-slate-200" />
                </div>

                <div className="space-y-3">
                  {group.items.map((item) => (
                    <ScheduleCard
                      key={item.id}
                      item={item}
                      studioSlug={studioSlug}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Quick Notes</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Floor rentals</p>
            <p className="mt-1 text-sm text-slate-600">
              Use My Rentals to review unpaid rental items and pay your running balance in one transaction.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Schedule visibility</p>
            <p className="mt-1 text-sm text-slate-600">
              This page shows items tied to your instructor link and your portal-linked client record.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}