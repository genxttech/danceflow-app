import Link from "next/link";
import { redirect } from "next/navigation";
import { canCreateAppointments } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStudioTimeZone } from "@/lib/booking/selfServiceAvailability";
import { createClient } from "@/lib/supabase/server";
import {
  createSelfServiceAvailabilityWindowAction,
  createSelfServiceBlackoutAction,
  deactivateSelfServiceAvailabilityWindowAction,
  deactivateSelfServiceBlackoutAction,
} from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type InstructorOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
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
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms: { name: string | null } | { name: string | null }[] | null;
};

type BlackoutRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  source: string;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
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

const BLACKOUT_SOURCES = [
  ["manual", "Manual"],
  ["studio_closed", "Studio Closed"],
  ["instructor_unavailable", "Instructor Unavailable"],
  ["room_unavailable", "Room Unavailable"],
  ["event", "Event"],
];

function firstItem<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatName(
  value: { first_name: string | null; last_name: string | null } | null | undefined
) {
  if (!value) return "Any instructor";
  return `${value.first_name ?? ""} ${value.last_name ?? ""}`.trim() || "Unnamed instructor";
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

function SelectOptions({
  instructors,
  rooms,
}: {
  instructors: InstructorOption[];
  rooms: RoomOption[];
}) {
  return (
    <>
      <label className="text-sm font-medium">
        Instructor
        <select name="instructorId" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2">
          <option value="">Any instructor</option>
          {instructors.map((instructor) => (
            <option key={instructor.id} value={instructor.id}>
              {`${instructor.first_name ?? ""} ${instructor.last_name ?? ""}`.trim()}
            </option>
          ))}
        </select>
      </label>

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
    </>
  );
}

export default async function SelfServiceAvailabilityPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const context = await getCurrentStudioContext();

  if (!canCreateAppointments(context.studioRole ?? "")) {
    redirect("/app/schedule");
  }

  const resolvedSearchParams = (await searchParams) ?? {};
  const supabase = await createClient();

  const [
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
    { data: windows, error: windowsError },
    { data: blackouts, error: blackoutsError },
    { data: settings, error: settingsError },
  ] = await Promise.all([
    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", context.studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),
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
        instructors (
          first_name,
          last_name
        ),
        rooms (
          name
        )
      `)
      .eq("studio_id", context.studioId)
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
        instructors (
          first_name,
          last_name
        ),
        rooms (
          name
        )
      `)
      .eq("studio_id", context.studioId)
      .eq("active", true)
      .order("starts_at", { ascending: true })
      .limit(100),
    supabase
      .from("studio_settings")
      .select("timezone")
      .eq("studio_id", context.studioId)
      .maybeSingle<{ timezone: string | null }>(),
  ]);

  if (instructorsError) throw new Error(instructorsError.message);
  if (roomsError) throw new Error(roomsError.message);
  if (windowsError) throw new Error(windowsError.message);
  if (blackoutsError) throw new Error(blackoutsError.message);
  if (settingsError) throw new Error(settingsError.message);

  const instructorOptions = (instructors ?? []) as InstructorOption[];
  const roomOptions = (rooms ?? []) as RoomOption[];
  const studioTimeZone = getStudioTimeZone(settings?.timezone);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
                Self-Service Scheduling
              </p>
              <h1 className="mt-1 text-2xl font-semibold">
                Availability
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
                Define the windows students can book and block dates that should not appear.
              </p>
            </div>

            <Link
              href="/app/schedule/self-service"
              className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            >
              Review requests
            </Link>
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

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">Add Availability Window</h2>
        <form action={createSelfServiceAvailabilityWindowAction} className="mt-4 grid gap-4 md:grid-cols-2">
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

          <label className="text-sm font-medium">
            Weekday
            <select name="weekday" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2">
              {WEEKDAYS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <SelectOptions instructors={instructorOptions} rooms={roomOptions} />

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

          <label className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm md:col-span-2">
            <input name="approvalRequired" type="checkbox" className="mr-2" />
            Require staff approval inside this window
          </label>

          <button className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 md:col-span-2">
            Add availability
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">Active Availability</h2>
        <div className="mt-4 divide-y divide-slate-200">
          {((windows ?? []) as AvailabilityWindowRow[]).length ? (
            ((windows ?? []) as AvailabilityWindowRow[]).map((window) => {
              const instructor = firstItem(window.instructors);
              const room = firstItem(window.rooms);
              return (
                <div key={window.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium text-slate-950">
                      {WEEKDAYS.find(([value]) => Number(value) === window.weekday)?.[1]} {formatTime(window.start_time)}-{formatTime(window.end_time)}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatType(window.lesson_type)} · {formatName(instructor)} · {formatRoom(room)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {window.effective_start_date || "No start date"} to {window.effective_end_date || "No end date"}
                      {window.approval_required ? " · approval required" : ""}
                    </p>
                  </div>
                  <form action={deactivateSelfServiceAvailabilityWindowAction}>
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

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">Add Blackout</h2>
        <form action={createSelfServiceBlackoutAction} className="mt-4 grid gap-4 md:grid-cols-2">
          <SelectOptions instructors={instructorOptions} rooms={roomOptions} />

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

          <label className="text-sm font-medium">
            Source
            <select name="source" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2">
              {BLACKOUT_SOURCES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm font-medium">
            Reason
            <input name="reason" className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2" />
          </label>

          <button className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 md:col-span-2">
            Add blackout
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-black/[0.02] md:p-6">
        <h2 className="text-lg font-semibold text-slate-950">Active Blackouts</h2>
        <div className="mt-4 divide-y divide-slate-200">
          {((blackouts ?? []) as BlackoutRow[]).length ? (
            ((blackouts ?? []) as BlackoutRow[]).map((blackout) => {
              const instructor = firstItem(blackout.instructors);
              const room = firstItem(blackout.rooms);
              return (
                <div key={blackout.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="font-medium text-slate-950">
                      {formatDateTime(blackout.starts_at, studioTimeZone)} to {formatDateTime(blackout.ends_at, studioTimeZone)}
                    </p>
                    <p className="text-sm text-slate-600">
                      {formatName(instructor)} · {formatRoom(room)} · {formatType(blackout.source)}
                    </p>
                    {blackout.reason ? (
                      <p className="text-xs text-slate-500">{blackout.reason}</p>
                    ) : null}
                  </div>
                  <form action={deactivateSelfServiceBlackoutAction}>
                    <input type="hidden" name="blackoutId" value={blackout.id} />
                    <button className="rounded-xl border border-rose-200 bg-white px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50">
                      Remove
                    </button>
                  </form>
                </div>
              );
            })
          ) : (
            <p className="py-4 text-sm text-slate-600">No active blackouts.</p>
          )}
        </div>
      </section>
    </div>
  );
}
