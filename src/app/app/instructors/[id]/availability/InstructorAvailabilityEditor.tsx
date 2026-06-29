import Link from "next/link";
import { redirect } from "next/navigation";
import { canManageInstructors } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioTimeZone } from "@/lib/booking/selfServiceAvailability";
import { createClient } from "@/lib/supabase/server";
import {
  createInstructorAvailabilityWindowAction,
  createInstructorBlackoutAction,
  deactivateInstructorAvailabilityWindowAction,
  deactivateInstructorBlackoutAction,
} from "./actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ success?: string; error?: string }>;

type InstructorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  active: boolean | null;
};

type RoomOption = {
  id: string;
  name: string | null;
};

type AvailabilityWindowRow = {
  id: string;
  lesson_type: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  effective_start_date: string | null;
  effective_end_date: string | null;
  approval_required: boolean | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

type BlackoutRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  source: string;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

const WEEKDAYS = [
  ["0", "Sunday"],
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
];

const LESSON_TYPES = [
  ["private_lesson", "Private Lesson"],
  ["coaching", "Coaching"],
  ["practice_party", "Practice Party"],
  ["group_class", "Group Class"],
];

const BRANDED_CARD_CLASS =
  "overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-[linear-gradient(180deg,#ffffff_0%,rgba(248,250,252,0.72)_100%)] p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6";

const BRANDED_FORM_PANEL_CLASS =
  "rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 p-3";

function firstItem<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || null;
}

function formatInstructorName(instructor: InstructorRow) {
  return (
    `${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim() ||
    instructor.email ||
    "Instructor"
  );
}

function formatRoom(value: { name: string | null } | null | undefined) {
  return value?.name || "Any room";
}

function formatType(value: string | null) {
  if (!value) return "Any lesson";
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTime(value: string) {
  return value.slice(0, 5);
}

function formatDate(value: string | null) {
  if (!value) return null;

  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;

  return `${month}/${day}/${year}`;
}

function getWeekdayLabel(weekday: number) {
  return WEEKDAYS.find(([value]) => Number(value) === weekday)?.[1] ?? "Unknown";
}

function groupWindowsByWeekday(windows: AvailabilityWindowRow[]) {
  const groups = new Map<number, AvailabilityWindowRow[]>();

  for (const [value] of WEEKDAYS) {
    groups.set(Number(value), []);
  }

  for (const window of windows) {
    const dayWindows = groups.get(window.weekday) ?? [];
    dayWindows.push(window);
    groups.set(window.weekday, dayWindows);
  }

  return groups;
}

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDayLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function groupBlackoutsByDay(blackouts: BlackoutRow[], timeZone: string) {
  const groups = new Map<string, BlackoutRow[]>();

  for (const blackout of blackouts) {
    const day = formatDayLabel(blackout.starts_at, timeZone);
    const dayBlackouts = groups.get(day) ?? [];
    dayBlackouts.push(blackout);
    groups.set(day, dayBlackouts);
  }

  return Array.from(groups.entries());
}

function RoomSelect({ rooms }: { rooms: RoomOption[] }) {
  return (
    <label className="text-sm font-medium">
      Room
      <select name="roomId" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2">
        <option value="">Any room</option>
        {rooms.map((room) => (
          <option key={room.id} value={room.id}>
            {room.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export async function InstructorAvailabilityEditor({
  params,
  searchParams,
  mode = "manage",
}: {
  params: Params;
  searchParams?: SearchParams;
  mode?: "manage" | "my";
}) {
  const { id } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const context = await getCurrentStudioContext();
  const supabase = await createClient();

  const { data: instructor, error: instructorError } = await supabase
    .from("instructors")
    .select("id, first_name, last_name, email, active")
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle<InstructorRow>();

  if (instructorError || !instructor) {
    throw new Error(instructorError?.message ?? "Instructor not found.");
  }

  const role = context.studioRole ?? "";
  const canManage =
    context.isPlatformAdmin || canManageInstructors(role);
  const isOwnInstructorProfile =
    ["instructor", "independent_instructor"].includes(role) &&
    normalizeEmail(context.email) === normalizeEmail(instructor.email);

  if (!canManage && !isOwnInstructorProfile) {
    redirect("/app");
  }

  const [
    { data: rooms, error: roomsError },
    { data: windows, error: windowsError },
    { data: blackouts, error: blackoutsError },
    { data: settings, error: settingsError },
  ] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", context.studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
    supabase
      .from("studio_booking_availability_windows")
      .select(`
        id,
        lesson_type,
        weekday,
        start_time,
        end_time,
        effective_start_date,
        effective_end_date,
        approval_required,
        rooms (
          name
        )
      `)
      .eq("studio_id", context.studioId)
      .eq("instructor_id", instructor.id)
      .eq("active", true)
      .order("weekday", { ascending: true })
      .order("start_time", { ascending: true }),
    supabase
      .from("studio_booking_blackouts")
      .select(`
        id,
        starts_at,
        ends_at,
        reason,
        source,
        rooms (
          name
        )
      `)
      .eq("studio_id", context.studioId)
      .eq("instructor_id", instructor.id)
      .eq("active", true)
      .order("starts_at", { ascending: true })
      .limit(100),
    supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", context.studioId)
      .maybeSingle<{ timezone: string | null }>(),
  ]);

  if (roomsError) throw new Error(roomsError.message);
  if (windowsError) throw new Error(windowsError.message);
  if (blackoutsError) throw new Error(blackoutsError.message);
  if (settingsError) throw new Error(settingsError.message);

  const roomOptions = (rooms ?? []) as RoomOption[];
  const activeWindows = (windows ?? []) as AvailabilityWindowRow[];
  const activeBlackouts = (blackouts ?? []) as BlackoutRow[];
  const windowsByWeekday = groupWindowsByWeekday(activeWindows);
  const studioTimeZone = getStudioTimeZone(settings?.timezone);
  const blackoutsByDay = groupBlackoutsByDay(activeBlackouts, studioTimeZone);
  const instructorName = formatInstructorName(instructor);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
                {mode === "my" ? "My Availability" : "Instructor Availability"}
              </p>
              <h1 className="mt-1 text-2xl font-semibold">
                {mode === "my" ? "My Availability" : instructorName}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                {mode === "my"
                  ? `Manage your weekly booking windows and unavailable times for ${instructorName}.`
                  : "Maintain weekly self-service booking windows and instructor unavailable times."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {canManage ? (
                <Link
                  href="/app/schedule/self-service/availability"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                >
                  Studio availability
                </Link>
              ) : null}
              {mode === "manage" ? (
                <Link
                  href="/app/instructors"
                  className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
                >
                  Back to instructors
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {resolvedSearchParams.error ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {resolvedSearchParams.error}
        </p>
      ) : null}

      {resolvedSearchParams.success ? (
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
          Saved.
        </p>
      ) : null}

      <section className={BRANDED_CARD_CLASS}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Weekly Calendar
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">
              Availability Overview
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              These windows power public booking, portal self-service scheduling, and the mobile app slot picker.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <span className="font-semibold text-slate-950">{activeWindows.length}</span>{" "}
            active window{activeWindows.length === 1 ? "" : "s"}
          </div>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-7">
          {WEEKDAYS.map(([value, label]) => {
            const weekday = Number(value);
            const dayWindows = windowsByWeekday.get(weekday) ?? [];

            return (
              <div
                key={value}
                className="min-h-40 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/25 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-950">{label}</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
                    {dayWindows.length}
                  </span>
                </div>

                <div className="mt-3 space-y-2">
                  {dayWindows.length ? (
                    dayWindows.map((window) => {
                      const room = firstItem(window.rooms);
                      const startDate = formatDate(window.effective_start_date);
                      const endDate = formatDate(window.effective_end_date);

                      return (
                        <div
                          key={window.id}
                          className="rounded-xl border border-[var(--brand-border)] bg-white p-3 shadow-sm"
                        >
                          <p className="text-sm font-semibold text-slate-950">
                            {formatTime(window.start_time)}-{formatTime(window.end_time)}
                          </p>
                          <p className="mt-1 text-xs font-medium text-slate-600">
                            {formatType(window.lesson_type)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {formatRoom(room)}
                          </p>
                          {(startDate || endDate || window.approval_required) ? (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {(startDate || endDate) ? (
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                                  {startDate ?? "Any start"} to {endDate ?? "No end"}
                                </span>
                              ) : null}
                              {window.approval_required ? (
                                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
                                  Approval
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                  ) : (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-white p-3 text-xs leading-5 text-slate-500">
                      No bookable windows.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className={BRANDED_CARD_CLASS}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Instructor Booking Rules
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Add Weekly Availability</h2>
        <form action={createInstructorAvailabilityWindowAction} className="mt-4 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="instructorId" value={instructor.id} />

          <label className="text-sm font-medium">
            Lesson type
            <select name="lessonType" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2">
              {LESSON_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <RoomSelect rooms={roomOptions} />

          <fieldset className={`${BRANDED_FORM_PANEL_CLASS} md:col-span-2`}>
            <legend className="px-1 text-sm font-semibold text-slate-900">
              Weekdays
            </legend>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {WEEKDAYS.map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
                >
                  <input name="weekdays" type="checkbox" value={value} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="text-sm font-medium">
            Start time
            <input name="startTime" type="time" defaultValue="09:00" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            End time
            <input name="endTime" type="time" defaultValue="17:00" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            Effective start date
            <input name="effectiveStartDate" type="date" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            Effective end date
            <input name="effectiveEndDate" type="date" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className={`${BRANDED_FORM_PANEL_CLASS} text-sm md:col-span-2`}>
            <input name="approvalRequired" type="checkbox" className="mr-2" />
            Require staff approval inside this window
          </label>

          <button className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 md:col-span-2">
            Add availability
          </button>
        </form>
      </section>

      <section className={BRANDED_CARD_CLASS}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Live Instructor Windows
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Active Availability</h2>
        <div className="mt-4 divide-y divide-[var(--brand-border)]">
          {activeWindows.length ? (
            activeWindows.map((window) => {
              const room = firstItem(window.rooms);
              return (
                <div key={window.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium text-slate-950">
                      {getWeekdayLabel(window.weekday)} {formatTime(window.start_time)}-{formatTime(window.end_time)}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatType(window.lesson_type)} · {formatRoom(room)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {window.effective_start_date || "No start date"} to {window.effective_end_date || "No end date"}
                      {window.approval_required ? " · approval required" : ""}
                    </p>
                  </div>
                  <form action={deactivateInstructorAvailabilityWindowAction}>
                    <input type="hidden" name="instructorId" value={instructor.id} />
                    <input type="hidden" name="availabilityWindowId" value={window.id} />
                    <button className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                      Remove
                    </button>
                  </form>
                </div>
              );
            })
          ) : (
            <p className="py-4 text-sm text-slate-600">No availability windows yet.</p>
          )}
        </div>
      </section>

      <section className={BRANDED_CARD_CLASS}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Instructor Time Off
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Add Unavailable Time</h2>
        <form action={createInstructorBlackoutAction} className="mt-4 grid gap-4 md:grid-cols-2">
          <input type="hidden" name="instructorId" value={instructor.id} />
          <input type="hidden" name="source" value="instructor_unavailable" />

          <RoomSelect rooms={roomOptions} />

          <label className="text-sm font-medium">
            Start date
            <input name="startDate" type="date" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            Start time
            <input name="startTime" type="time" defaultValue="09:00" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            End date
            <input name="endDate" type="date" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <label className="text-sm font-medium">
            End time
            <input name="endTime" type="time" defaultValue="17:00" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <fieldset className={`${BRANDED_FORM_PANEL_CLASS} md:col-span-2`}>
            <legend className="px-1 text-sm font-semibold text-slate-900">
              Repeat on weekdays
            </legend>
            <p className="mt-1 text-xs text-slate-500">
              Optional. Choose weekdays to create separate unavailable blocks across the selected date range.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {WEEKDAYS.map(([value, label]) => (
                <label
                  key={value}
                  className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700"
                >
                  <input name="blackoutWeekdays" type="checkbox" value={value} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="text-sm font-medium md:col-span-2">
            Reason
            <input name="reason" placeholder="Vacation, event, travel, etc." className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <button className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 md:col-span-2">
            Add unavailable time
          </button>
        </form>
      </section>

      <section className={BRANDED_CARD_CLASS}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Exception Calendar
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">
          Upcoming Unavailable Days
        </h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {blackoutsByDay.length ? (
            blackoutsByDay.map(([day, dayBlackouts]) => (
              <div
                key={day}
                className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/25 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-slate-950">{day}</h3>
                  <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
                    {dayBlackouts.length}
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {dayBlackouts.map((blackout) => {
                    const room = firstItem(blackout.rooms);

                    return (
                      <div
                        key={blackout.id}
                        className="rounded-xl border border-[var(--brand-border)] bg-white p-3 text-sm shadow-sm"
                      >
                        <p className="font-medium text-slate-950">
                          {formatDateTime(blackout.starts_at, studioTimeZone)} to {formatDateTime(blackout.ends_at, studioTimeZone)}
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          {formatRoom(room)} · {formatType(blackout.source)}
                        </p>
                        {blackout.reason ? (
                          <p className="mt-1 text-xs text-slate-500">{blackout.reason}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600 md:col-span-2 xl:col-span-3">
              No unavailable days are currently blocking self-service booking.
            </p>
          )}
        </div>
      </section>

      <section className={BRANDED_CARD_CLASS}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
          Hidden From Booking
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-950">Active Unavailable Times</h2>
        <div className="mt-4 divide-y divide-[var(--brand-border)]">
          {activeBlackouts.length ? (
            activeBlackouts.map((blackout) => {
              const room = firstItem(blackout.rooms);
              return (
                <div key={blackout.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium text-slate-950">
                      {formatDateTime(blackout.starts_at, studioTimeZone)} to {formatDateTime(blackout.ends_at, studioTimeZone)}
                    </p>
                    <p className="text-sm text-slate-600">
                      {formatRoom(room)} · {formatType(blackout.source)}
                    </p>
                    {blackout.reason ? (
                      <p className="text-xs text-slate-500">{blackout.reason}</p>
                    ) : null}
                  </div>
                  <form action={deactivateInstructorBlackoutAction}>
                    <input type="hidden" name="instructorId" value={instructor.id} />
                    <input type="hidden" name="blackoutId" value={blackout.id} />
                    <button className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                      Remove
                    </button>
                  </form>
                </div>
              );
            })
          ) : (
            <p className="py-4 text-sm text-slate-600">No active unavailable times.</p>
          )}
        </div>
      </section>
    </div>
  );
}

