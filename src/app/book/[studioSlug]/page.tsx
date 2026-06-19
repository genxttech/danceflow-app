import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import BookingRequestForm from "./BookingRequestForm";

const DEFAULT_TIME_ZONE = "America/New_York";

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedDateTimeParts(value: Date | string, timeZone: string) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hourPart = part("hour");

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: hourPart === 24 ? 0 : hourPart,
    minute: part("minute"),
    second: part("second"),
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let index = 0; index < 3; index += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hours, minutes, 0, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));

  return date.toISOString().slice(0, 10);
}

function getZonedWeekday(dateKey: string, timeZone: string) {
  const date = zonedDateTimeToUtcDate(dateKey, "12:00", timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

function getLocalDayUtcRange(dateKey: string, timeZone: string) {
  const safeTimeZone = getStudioTimeZone(timeZone);
  const nextDateKey = addDaysToDateKey(dateKey, 1);

  return {
    startIso: zonedDateTimeToUtcIso(dateKey, "00:00", safeTimeZone),
    endIso: zonedDateTimeToUtcIso(nextDateKey, "00:00", safeTimeZone),
  };
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not requested";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(new Date(value));
}

function formatStudioTime(value: string | null | undefined, timeZone: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

type SearchParams = Promise<{
  slotStart?: string;
  success?: string;
}>;

type StudioRow = {
  id: string;
  name: string;
  slug: string;
  public_logo_url: string | null;
  public_primary_color: string | null;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_lead_cta_text: string | null;
};

type StudioSettingsRow = {
  timezone: string | null;
  booking_lead_time_hours: number | null;
  public_intro_booking_enabled: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
  intro_default_instructor_id: string | null;
  intro_default_room_id: string | null;
  booking_request_allowed_weekdays: number[] | null;
  booking_request_start_time: string | null;
  booking_request_end_time: string | null;
  public_intro_bookable_instructor_ids: string[] | null;
};

type InstructorRow = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

type RoomRow = {
  id: string;
  name: string;
  active: boolean;
};

type AppointmentRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
};

type SlotRow = {
  start: string;
  end: string;
};

const INTRO_SLOT_TEMPLATES: Record<number, string[]> = {
  0: [],
  1: ["13:00", "15:00", "18:00"],
  2: ["13:00", "15:00", "18:00"],
  3: ["13:00", "15:00", "18:00"],
  4: ["13:00", "15:00", "18:00"],
  5: ["13:00", "15:00", "18:00"],
  6: ["11:00", "13:00"],
};

function getAllowedWeekdays(settings: StudioSettingsRow) {
  return settings.booking_request_allowed_weekdays?.length
    ? settings.booking_request_allowed_weekdays
    : [1, 2, 3, 4, 5, 6];
}

function timeWithinRequestWindow(time: string, settings: StudioSettingsRow) {
  const start = (settings.booking_request_start_time ?? "09:00").slice(0, 5);
  const end = (settings.booking_request_end_time ?? "21:00").slice(0, 5);

  return time >= start && time < end;
}

function formatRequestWindow(settings: StudioSettingsRow) {
  const start = (settings.booking_request_start_time ?? "09:00").slice(0, 5);
  const end = (settings.booking_request_end_time ?? "21:00").slice(0, 5);
  return `${start}–${end}`;
}

function getPublicIntroInstructorId(settings: StudioSettingsRow) {
  const allowedIds = settings.public_intro_bookable_instructor_ids ?? [];

  if (!allowedIds.length) {
    return settings.intro_default_instructor_id;
  }

  if (
    settings.intro_default_instructor_id &&
    allowedIds.includes(settings.intro_default_instructor_id)
  ) {
    return settings.intro_default_instructor_id;
  }

  return allowedIds[0] ?? null;
}

function formatLongDate(value: string, timeZone: string) {
  return formatStudioDate(`${value}T12:00:00.000Z`, "UTC", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(value: string, timeZone: string) {
  return formatStudioTime(value, timeZone);
}

function formatSelectedSlot(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function buildStudioDateTime(dateKey: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(dateKey, time, timeZone);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

function groupSlotsByDate(slots: SlotRow[], timeZone: string) {
  const map = new Map<string, SlotRow[]>();

  for (const slot of slots) {
    const key = getZonedDateKey(slot.start, timeZone);
    const existing = map.get(key) ?? [];
    existing.push(slot);
    map.set(key, existing);
  }

  return Array.from(map.entries()).map(([date, rows]) => ({
    date,
    slots: rows.sort((a, b) => a.start.localeCompare(b.start)),
  }));
}

export default async function PublicIntroBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ studioSlug: string }>;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const query = await searchParams;
  const selectedSlotStart = query.slotStart ?? "";
  const success = query.success ?? "";
  const isSuccess = success === "intro_requested" || success === "intro_booked";

  const supabase = await createClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select(`
      id,
      name,
      slug,
      public_logo_url,
      public_primary_color,
      public_lead_headline,
      public_lead_description,
      public_lead_cta_text
    `)
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    notFound();
  }

  const { data: settings, error: settingsError } = await supabase
    .from("studio_settings")
    .select(`
      timezone,
      booking_lead_time_hours,
      public_intro_booking_enabled,
      intro_lesson_duration_minutes,
      intro_booking_window_days,
      intro_default_instructor_id,
      intro_default_room_id,
      booking_request_allowed_weekdays,
      booking_request_start_time,
      booking_request_end_time,
      public_intro_bookable_instructor_ids
    `)
    .eq("studio_id", studio.id)
    .single();

  if (settingsError || !settings) {
    notFound();
  }

  const typedStudio = studio as StudioRow;
  const typedSettings = settings as StudioSettingsRow;

  if (!typedSettings.public_intro_booking_enabled) {
    notFound();
  }

  const studioTimeZone = getStudioTimeZone(typedSettings.timezone);
  const bookingWindowDays = typedSettings.intro_booking_window_days ?? 7;
  const lessonDurationMinutes = typedSettings.intro_lesson_duration_minutes ?? 30;
  const bookingLeadTimeHours = typedSettings.booking_lead_time_hours ?? 0;
  const allowedWeekdays = getAllowedWeekdays(typedSettings);

  const introInstructorId = getPublicIntroInstructorId(typedSettings);

  const [{ data: instructor }, { data: room }] = await Promise.all([
    introInstructorId
      ? supabase
          .from("instructors")
          .select("id, first_name, last_name, active")
          .eq("studio_id", typedStudio.id)
          .eq("id", introInstructorId)
          .single()
      : Promise.resolve({ data: null, error: null }),
    typedSettings.intro_default_room_id
      ? supabase
          .from("rooms")
          .select("id, name, active")
          .eq("studio_id", typedStudio.id)
          .eq("id", typedSettings.intro_default_room_id)
          .single()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const typedInstructor = instructor as InstructorRow | null;
  const typedRoom = room as RoomRow | null;

  const todayKey = getZonedDateKey(new Date(), studioTimeZone);
  const rangeStart = getLocalDayUtcRange(todayKey, studioTimeZone).startIso;
  const rangeEnd = getLocalDayUtcRange(addDaysToDateKey(todayKey, bookingWindowDays + 1), studioTimeZone).startIso;

  let appointmentsQuery = supabase
    .from("appointments")
    .select("id, starts_at, ends_at, status")
    .eq("studio_id", typedStudio.id)
    .gte("starts_at", rangeStart)
    .lt("starts_at", rangeEnd)
    .neq("status", "cancelled");

  if (typedInstructor?.id) {
    appointmentsQuery = appointmentsQuery.eq("instructor_id", typedInstructor.id);
  }

  if (typedRoom?.id) {
    appointmentsQuery = appointmentsQuery.eq("room_id", typedRoom.id);
  }

  const { data: appointments, error: appointmentsError } = await appointmentsQuery;

  if (appointmentsError) {
    throw new Error(`Failed to load public intro availability: ${appointmentsError.message}`);
  }

  const typedAppointments = (appointments ?? []) as AppointmentRow[];
  const leadTimeCutoff = new Date(Date.now() + bookingLeadTimeHours * 60 * 60 * 1000);

  const generatedSlots: SlotRow[] = [];

  for (let dayOffset = 0; dayOffset < bookingWindowDays; dayOffset++) {
    const dayDateKey = addDaysToDateKey(todayKey, dayOffset);
    const dayOfWeek = getZonedWeekday(dayDateKey, studioTimeZone);

    if (!allowedWeekdays.includes(dayOfWeek)) {
      continue;
    }

    const times = (INTRO_SLOT_TEMPLATES[dayOfWeek] ?? []).filter((time) =>
      timeWithinRequestWindow(time, typedSettings)
    );

    for (const time of times) {
      const start = buildStudioDateTime(dayDateKey, time, studioTimeZone);
      const end = addMinutes(start, lessonDurationMinutes);

      if (start < leadTimeCutoff) {
        continue;
      }

      const hasConflict = typedAppointments.some((appointment) => {
        const apptStart = new Date(appointment.starts_at);
        const apptEnd = new Date(appointment.ends_at);

        return overlaps(start, end, apptStart, apptEnd);
      });

      if (!hasConflict) {
        generatedSlots.push({
          start: start.toISOString(),
          end: end.toISOString(),
        });
      }
    }
  }

  const groupedSlots = groupSlotsByDate(generatedSlots, studioTimeZone);
  const selectedSlot =
    generatedSlots.find((slot) => slot.start === selectedSlotStart) ??
    (selectedSlotStart
      ? {
          start: selectedSlotStart,
          end: new Date(
            new Date(selectedSlotStart).getTime() + lessonDurationMinutes * 60 * 1000
          ).toISOString(),
        }
      : null);

  const headline =
    typedStudio.public_lead_headline || `Request Your Intro Lesson at ${typedStudio.name}`;
  const description =
    typedStudio.public_lead_description ||
    "Choose an available intro lesson time below and send your request.";
  const accentColor = typedStudio.public_primary_color || "#0f172a";
  const ctaText = typedStudio.public_lead_cta_text || "Request Intro Lesson";

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_#FDF2F8,_transparent_34%),linear-gradient(135deg,_#FFF7ED_0%,_#F8FAFC_42%,_#FDF2F8_100%)] px-4 py-10">
      <div className="mx-auto max-w-6xl">
        <div className="overflow-hidden rounded-[34px] border border-white/70 bg-white/95 shadow-xl shadow-slate-200/70 backdrop-blur">
          <div
            className="relative overflow-hidden border-b border-slate-200 px-6 py-8 md:px-8"
            style={{ borderTop: `7px solid ${accentColor}` }}
          >
            <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-r from-[#F97316]/10 via-[#EC4899]/10 to-[#7C3AED]/10" />
            <div className="relative flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <p className="inline-flex rounded-full bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D] ring-1 ring-pink-100">
                  DanceFlow booking request
                </p>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                  {headline}
                </h1>
                <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">{description}</p>

                <div className="mt-6 grid gap-3 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-3">
                  <span className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                    <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Lesson length
                    </span>
                    <span className="mt-1 block font-semibold text-slate-900">
                      {lessonDurationMinutes} minutes
                    </span>
                  </span>

                  <span className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                    <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                      Request window
                    </span>
                    <span className="mt-1 block font-semibold text-slate-900">
                      {formatRequestWindow(typedSettings)}
                    </span>
                  </span>

                  {typedInstructor?.active ? (
                    <span className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                        Instructor
                      </span>
                      <span className="mt-1 block font-semibold text-slate-900">
                        {typedInstructor.first_name} {typedInstructor.last_name}
                      </span>
                    </span>
                  ) : null}

                  {typedRoom?.active ? (
                    <span className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                        Room
                      </span>
                      <span className="mt-1 block font-semibold text-slate-900">
                        {typedRoom.name}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>

              {typedStudio.public_logo_url ? (
                <img
                  src={typedStudio.public_logo_url}
                  alt={`${typedStudio.name} logo`}
                  className="h-20 w-20 rounded-3xl border border-slate-200 bg-white object-contain p-2 shadow-sm"
                />
              ) : null}
            </div>
          </div>

          <div className="px-6 py-8 md:px-8">
            {isSuccess ? (
              <div className="rounded-[30px] border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-8 shadow-sm">
                <div className="max-w-2xl">
                  <p className="inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                    Request received
                  </p>
                  <h2 className="mt-4 text-3xl font-semibold tracking-tight text-emerald-950">
                    Your intro lesson request is on its way to the studio.
                  </h2>
                  <p className="mt-3 text-base leading-7 text-emerald-900">
                    The studio will review your selected time and follow up with confirmation
                    or next steps. This is a request, not a confirmed appointment yet.
                  </p>

                  {selectedSlot ? (
                    <div className="mt-6 rounded-2xl border border-green-200 bg-white p-5">
                      <p className="text-sm text-slate-500">Requested time</p>
                      <p className="mt-2 text-lg font-medium text-slate-900">
                        {formatSelectedSlot(selectedSlot.start, studioTimeZone)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Duration: {lessonDurationMinutes} minutes
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-6 flex flex-wrap gap-3">
                    <Link
                      href={`/book/${typedStudio.slug}`}
                      className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
                    >
                      Back to booking page
                    </Link>
                    <Link href="/" className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
                      Back home
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-4 rounded-[28px] border border-slate-200 bg-slate-50/80 p-5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                      Step 1
                    </p>
                    <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                      Choose an intro request time
                    </h2>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                      Pick a preferred time below, then complete the request form. The studio will
                      review the request before it becomes a confirmed appointment.
                    </p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 shadow-sm">
                    Window: next {bookingWindowDays} day{bookingWindowDays === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="mt-6 space-y-6">
                  {groupedSlots.length === 0 ? (
                    <div className="rounded-[28px] border border-dashed border-slate-300 bg-white p-8 text-center text-slate-600 shadow-sm">
                      <p className="text-lg font-semibold text-slate-950">
                        No request times are available right now.
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        Please check back soon or contact the studio directly for help finding an intro lesson time.
                      </p>
                    </div>
                  ) : (
                    groupedSlots.map((group) => (
                      <section key={group.date} className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                        <div className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-pink-50/50 px-5 py-4">
                          <h3 className="font-semibold text-slate-950">
                            {formatLongDate(group.date, studioTimeZone)}
                          </h3>
                        </div>

                        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
                          {group.slots.map((slot) => {
                            const isSelected = slot.start === selectedSlotStart;
                            const href = `/book/${typedStudio.slug}?slotStart=${encodeURIComponent(
                              slot.start
                            )}`;

                            return (
                              <Link
                                key={slot.start}
                                href={href}
                                className={`rounded-2xl border p-4 transition ${
                                  isSelected
                                    ? "border-slate-950 bg-slate-950 text-white shadow-lg shadow-slate-300/50"
                                    : "border-slate-200 bg-white shadow-sm hover:-translate-y-0.5 hover:border-pink-200 hover:bg-pink-50/40"
                                }`}
                              >
                                <p className="text-base font-medium">
                                  {formatTime(slot.start, studioTimeZone)} – {formatTime(slot.end, studioTimeZone)}
                                </p>
                                <p
                                  className={`mt-2 text-sm ${
                                    isSelected ? "text-slate-200" : "text-slate-500"
                                  }`}
                                >
                                  {isSelected ? "Selected request time" : "Request this time"}
                                </p>
                              </Link>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                </div>

                <div className="mt-10 rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#BE185D]">
                    Step 2
                  </p>
                  <h3 className="mt-1 text-2xl font-semibold text-slate-950">
                    Complete your request
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    Share your contact information and any notes that will help the studio prepare.
                  </p>

                  {!selectedSlot ? (
                    <p className="mt-3 text-slate-600">
                      Select a time above to continue with your intro lesson request.
                    </p>
                  ) : (
                    <BookingRequestForm
                      studioSlug={typedStudio.slug}
                      slotStart={selectedSlot.start}
                      selectedSlotLabel={formatSelectedSlot(selectedSlot.start, studioTimeZone)}
                      ctaText={ctaText}
                    />
                  )}
                </div>
              </>
            )}

            <div className="mt-6">
              <Link href="/" className="text-sm font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-950">
                Back
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}