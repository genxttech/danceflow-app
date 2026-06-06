import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type PageProps = {
  params: Promise<{
    studioSlug: string;
  }>;
};

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  studio_id: string;
  is_independent_instructor: boolean | null;
  linked_instructor_id: string | null;
};

type StudioSettingsRow = {
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_cancellation_cutoff_hours: number | null;
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

type LessonRecapRow = {
  id: string;
  appointment_id: string;
  summary: string | null;
  homework: string | null;
  next_focus: string | null;
  visible_to_client: boolean | null;
  updated_at: string;
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
  value: { name: string } | { name: string }[] | null | undefined
) {
  const room = getSingle(value);
  return room?.name ?? "No room listed";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatTimeRange(start: string, end: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${formatter.format(new Date(start))} – ${formatter.format(new Date(end))}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
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
  if (type === "floor_space_rental") return "bg-indigo-50 text-indigo-700 ring-indigo-100";
  if (type === "private_lesson") return "bg-slate-100 text-slate-700 ring-slate-200";
  if (type === "group_class") return "bg-green-50 text-green-700 ring-green-100";
  if (type === "intro_lesson") return "bg-cyan-50 text-cyan-700 ring-cyan-100";
  if (type === "coaching") return "bg-purple-50 text-purple-700 ring-purple-100";
  if (type === "practice_party") return "bg-amber-50 text-amber-700 ring-amber-100";
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
  isIndependentInstructor,
  recap,
}: {
  item: CalendarRow;
  studioSlug: string;
  isIndependentInstructor: boolean;
  recap?: LessonRecapRow;
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

          {recap ? (
            <div className="mt-4 rounded-2xl border border-violet-100 bg-violet-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-violet-950">Lesson Recap</p>
                <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-violet-700 ring-1 ring-violet-100">
                  Updated {formatDateTime(recap.updated_at)}
                </span>
              </div>
              {recap.summary ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">{recap.summary}</p>
              ) : null}
              {recap.homework ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">
                  <span className="font-medium">Homework:</span> {recap.homework}
                </p>
              ) : null}
              {recap.next_focus ? (
                <p className="mt-2 text-sm leading-6 text-violet-900">
                  <span className="font-medium">Next focus:</span> {recap.next_focus}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {isRental && isIndependentInstructor ? (
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

async function loadAppointments(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  studioId: string;
  client: ClientRow;
}) {
  const { supabase, studioId, client } = params;

  let query = supabase
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
    .eq("studio_id", studioId)
    .order("starts_at", { ascending: true });

  if (client.is_independent_instructor && client.linked_instructor_id) {
    query = query.or(
      `client_id.eq.${client.id},instructor_id.eq.${client.linked_instructor_id}`
    );
  } else {
    query = query.eq("client_id", client.id);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const dedupedMap = new Map<string, CalendarRow>();
  for (const row of (data ?? []) as CalendarRow[]) {
    dedupedMap.set(row.id, row);
  }

  return Array.from(dedupedMap.values()).sort((a, b) =>
    a.starts_at.localeCompare(b.starts_at)
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
    .select("id, name, slug, public_name")
    .eq("slug", studioSlug)
    .maybeSingle();

  if (studioError || !studio) {
    notFound();
  }

  const { data: studioSettings, error: studioSettingsError } = await supabase
    .from("studio_settings")
    .select(`
      portal_self_scheduling_enabled,
      portal_self_scheduling_mode,
      portal_self_scheduling_window_days,
      portal_self_scheduling_min_notice_hours,
      portal_self_scheduling_cancellation_cutoff_hours
    `)
    .eq("studio_id", studio.id)
    .maybeSingle<StudioSettingsRow>();

  if (studioSettingsError) {
    throw new Error(`Failed to load scheduling settings: ${studioSettingsError.message}`);
  }

  const schedulingSettings: StudioSettingsRow = studioSettings ?? {
    portal_self_scheduling_enabled: false,
    portal_self_scheduling_mode: "disabled",
    portal_self_scheduling_window_days: 14,
    portal_self_scheduling_min_notice_hours: 24,
    portal_self_scheduling_cancellation_cutoff_hours: 24,
  };

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
    .maybeSingle<ClientRow>();

  if (portalClientError || !portalClient) {
    redirect(`/portal/${studioSlug}`);
  }

  const isIndependentInstructor = portalClient.is_independent_instructor === true;
  const appointments = await loadAppointments({
    supabase,
    studioId: studio.id,
    client: portalClient,
  });

  const recapAppointmentIds = appointments
    .filter((item) => item.status === "attended")
    .map((item) => item.id);

  let lessonRecaps: LessonRecapRow[] = [];

  if (recapAppointmentIds.length) {
    const { data, error } = await supabase
      .from("lesson_recaps")
      .select("id, appointment_id, summary, homework, next_focus, visible_to_client, updated_at")
      .eq("studio_id", studio.id)
      .in("appointment_id", recapAppointmentIds)
      .eq("visible_to_client", true)
      .order("updated_at", { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    lessonRecaps = (data ?? []) as LessonRecapRow[];
  }

  const recapByAppointmentId = new Map(
    lessonRecaps.map((recap) => [recap.appointment_id, recap])
  );

  const now = new Date();
  const upcoming = appointments.filter((row) => new Date(row.ends_at) >= now);
  const recent = appointments
    .filter((row) => new Date(row.ends_at) < now)
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
    .slice(0, 30);

  const upcomingGroups = groupByDay(upcoming);
  const recentGroups = groupByDay(recent);

  const rentalCount = appointments.filter(
    (row) => row.appointment_type === "floor_space_rental"
  ).length;

  const studioLabel = studio.public_name?.trim() || studio.name;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-7 text-white md:px-8">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Portal
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
                My Schedule
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85">
                Review upcoming appointments, past lessons, and shared lesson recaps for {studioLabel}.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Upcoming
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{upcoming.length}</p>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Recent
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{recent.length}</p>
              </div>

              <div className="rounded-2xl border border-white/15 bg-white/10 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/65">
                  Recaps
                </p>
                <p className="mt-1 text-2xl font-semibold text-white">{lessonRecaps.length}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <Link
            href={`/portal/${studioSlug}`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Portal
          </Link>

          {isIndependentInstructor ? (
            <>
              <Link
                href={`/portal/${studioSlug}/floor-space/book`}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Book Floor Space
              </Link>

              <Link
                href={`/portal/${studioSlug}/floor-space/my-rentals`}
                className="inline-flex items-center justify-center rounded-xl bg-[var(--brand-accent-dark)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
              >
                My Rentals
              </Link>
            </>
          ) : null}
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-violet-600">
              Scheduling requests
            </p>
            <h2 className="mt-2 text-lg font-semibold text-slate-900">
              {schedulingSettings.portal_self_scheduling_enabled
                ? "Student schedule requests are enabled"
                : "Student self-scheduling is not enabled"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
              {schedulingSettings.portal_self_scheduling_enabled
                ? `This studio accepts portal schedule requests up to ${
                    schedulingSettings.portal_self_scheduling_window_days ?? 14
                  } days ahead with at least ${
                    schedulingSettings.portal_self_scheduling_min_notice_hours ?? 24
                  } hours of notice. Staff approval is still required before schedule changes are confirmed.`
                : "This studio is not accepting portal schedule requests right now. Contact the studio directly if you need to book, cancel, or reschedule a lesson."}
            </p>
          </div>

          <Link
            href={`/portal/${studioSlug}/profile`}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Update Contact Info
          </Link>
        </div>

        {schedulingSettings.portal_self_scheduling_enabled ? (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Mode</p>
              <p className="mt-1 text-sm text-slate-600">Request only</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Booking window</p>
              <p className="mt-1 text-sm text-slate-600">
                Next {schedulingSettings.portal_self_scheduling_window_days ?? 14} days
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-medium text-slate-900">Cutoff</p>
              <p className="mt-1 text-sm text-slate-600">
                {schedulingSettings.portal_self_scheduling_cancellation_cutoff_hours ?? 24} hours
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Upcoming Schedule</h2>
          <p className="mt-1 text-sm text-slate-500">
            Future lessons, classes, rentals, and studio appointments connected to your portal.
          </p>
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
                      isIndependentInstructor={isIndependentInstructor}
                      recap={recapByAppointmentId.get(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Past Appointments & Recaps</h2>
          <p className="mt-1 text-sm text-slate-500">
            Review recent appointments and any lesson recaps your instructor has shared.
          </p>
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
                      isIndependentInstructor={isIndependentInstructor}
                      recap={recapByAppointmentId.get(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-900">Schedule Notes</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">Lesson recaps</p>
            <p className="mt-1 text-sm text-slate-600">
              Recaps appear here after your instructor shares them from an attended private lesson.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-900">
              {isIndependentInstructor ? "Floor rentals" : "Need a schedule change?"}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {isIndependentInstructor
                ? `You have ${rentalCount} floor rental item${rentalCount === 1 ? "" : "s"} connected to this portal.`
                : "Contact the studio if an appointment time, status, or room looks incorrect."}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
