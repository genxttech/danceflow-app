import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import BookingRequestForm from "./BookingRequestForm";

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

function formatLongDate(value: string) {
  return new Date(value).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatSelectedSlot(value: string) {
  return new Date(value).toLocaleString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toLocalDateParts(date: Date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth(),
    day: date.getDate(),
  };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfTodayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function buildLocalDateTime(date: Date, time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  const { year, month, day } = toLocalDateParts(date);
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && aEnd > bStart;
}

function groupSlotsByDate(slots: SlotRow[]) {
  const map = new Map<string, SlotRow[]>();

  for (const slot of slots) {
    const key = slot.start.slice(0, 10);
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
  const isSuccess = success === "intro_booked";

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
      intro_default_room_id
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

  const bookingWindowDays = typedSettings.intro_booking_window_days ?? 7;
  const lessonDurationMinutes = typedSettings.intro_lesson_duration_minutes ?? 30;
  const bookingLeadTimeHours = typedSettings.booking_lead_time_hours ?? 0;

  const [{ data: instructor }, { data: room }] = await Promise.all([
    typedSettings.intro_default_instructor_id
      ? supabase
          .from("instructors")
          .select("id, first_name, last_name, active")
          .eq("studio_id", typedStudio.id)
          .eq("id", typedSettings.intro_default_instructor_id)
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

  const today = startOfTodayLocal();
  const rangeStart = today.toISOString();
  const rangeEnd = addDays(today, bookingWindowDays + 1).toISOString();

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
    const dayDate = addDays(today, dayOffset);
    const dayOfWeek = dayDate.getDay();
    const times = INTRO_SLOT_TEMPLATES[dayOfWeek] ?? [];

    for (const time of times) {
      const start = buildLocalDateTime(dayDate, time);
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

  const groupedSlots = groupSlotsByDate(generatedSlots);
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
    typedStudio.public_lead_headline || `Book Your Intro Lesson at ${typedStudio.name}`;
  const description =
    typedStudio.public_lead_description ||
    "Choose an available intro lesson time below and get started.";
  const accentColor = typedStudio.public_primary_color || "#0f172a";
  const ctaText = typedStudio.public_lead_cta_text || "Book Intro Lesson";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <div className="overflow-hidden rounded-3xl border bg-white shadow-sm">
          <div
            className="border-b px-6 py-8 md:px-8"
            style={{ borderTop: `6px solid ${accentColor}` }}
          >
            <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
                  Intro Lesson Booking
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
                  {headline}
                </h1>
                <p className="mt-3 max-w-2xl text-slate-600">{description}</p>

                <div className="mt-5 flex flex-wrap gap-3 text-sm text-slate-600">
                  <span className="rounded-full bg-slate-100 px-3 py-1">
                    {lessonDurationMinutes} minutes
                  </span>

                  {typedInstructor?.active ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1">
                      Instructor: {typedInstructor.first_name} {typedInstructor.last_name}
                    </span>
                  ) : null}

                  {typedRoom?.active ? (
                    <span className="rounded-full bg-slate-100 px-3 py-1">
                      Room: {typedRoom.name}
                    </span>
                  ) : null}
                </div>
              </div>

              {typedStudio.public_logo_url ? (
                <img
                  src={typedStudio.public_logo_url}
                  alt={`${typedStudio.name} logo`}
                  className="h-16 w-16 rounded-xl object-contain"
                />
              ) : null}
            </div>
          </div>

          <div className="px-6 py-8 md:px-8">
            {isSuccess ? (
              <div className="rounded-3xl border border-green-200 bg-green-50 p-8">
                <div className="max-w-2xl">
                  <p className="text-sm font-medium uppercase tracking-wide text-green-700">
                    Booking Confirmed
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight text-green-900">
                    Your intro lesson has been booked.
                  </h2>
                  <p className="mt-3 text-green-800">
                    We’ve reserved your selected intro lesson slot. The studio can now follow up
                    with any next steps.
                  </p>

                  {selectedSlot ? (
                    <div className="mt-6 rounded-2xl border border-green-200 bg-white p-5">
                      <p className="text-sm text-slate-500">Reserved time</p>
                      <p className="mt-2 text-lg font-medium text-slate-900">
                        {formatSelectedSlot(selectedSlot.start)}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Duration: {lessonDurationMinutes} minutes
                      </p>
                    </div>
                  ) : null}

                  <div className="mt-6 flex flex-wrap gap-3">
                    <Link
                      href={`/book/${typedStudio.slug}`}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
                    >
                      Back to booking page
                    </Link>
                    <Link href="/" className="rounded-xl border px-4 py-2 hover:bg-slate-50">
                      Back home
                    </Link>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-900">Available Intro Slots</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Choose a time, then complete the form below.
                    </p>
                  </div>

                  <div className="text-sm text-slate-500">
                    Window: next {bookingWindowDays} day{bookingWindowDays === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="mt-6 space-y-6">
                  {groupedSlots.length === 0 ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-slate-600">
                      No intro lesson slots are currently available in the active booking window.
                    </div>
                  ) : (
                    groupedSlots.map((group) => (
                      <section key={group.date} className="rounded-2xl border border-slate-200">
                        <div className="border-b bg-slate-50 px-5 py-4">
                          <h3 className="font-medium text-slate-900">
                            {formatLongDate(group.date)}
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
                                className={`rounded-xl border p-4 ${
                                  isSelected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white hover:bg-slate-50"
                                }`}
                              >
                                <p className="text-base font-medium">
                                  {formatTime(slot.start)} – {formatTime(slot.end)}
                                </p>
                                <p
                                  className={`mt-2 text-sm ${
                                    isSelected ? "text-slate-200" : "text-slate-500"
                                  }`}
                                >
                                  {isSelected ? "Selected slot" : "Choose this time"}
                                </p>
                              </Link>
                            );
                          })}
                        </div>
                      </section>
                    ))
                  )}
                </div>

                <div className="mt-10 rounded-2xl border border-slate-200 bg-slate-50 p-6">
                  <h3 className="text-xl font-semibold text-slate-900">Complete Your Booking</h3>

                  {!selectedSlot ? (
                    <p className="mt-3 text-slate-600">
                      Select a time above to continue with your intro lesson request.
                    </p>
                  ) : (
                    <BookingRequestForm
                      studioSlug={typedStudio.slug}
                      slotStart={selectedSlot.start}
                      selectedSlotLabel={formatSelectedSlot(selectedSlot.start)}
                      ctaText={ctaText}
                    />
                  )}
                </div>
              </>
            )}

            <div className="mt-6">
              <Link href="/" className="text-sm underline text-slate-600">
                Back
              </Link>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}