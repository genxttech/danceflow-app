import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { normalizePublicToken } from "@/lib/security/tokens";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

type Params = Promise<{
  token: string;
}>;

type CoachRow = {
  id: string;
  event_id: string;
  studio_id: string | null;
  organizer_id: string | null;
  name: string;
  bio: string | null;
  photo_url: string | null;
  schedule_token_enabled: boolean | null;
  active: boolean;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  start_date: string | null;
  end_date: string | null;
  venue_name: string | null;
  city: string | null;
  state: string | null;
  timezone: string | null;
  status: string | null;
  visibility: string | null;
  public_directory_enabled: boolean | null;
  studio_id: string | null;
  organizer_id: string | null;
};

type StudioRow = {
  id: string;
  name: string | null;
  slug: string | null;
  subscription_status: string | null;
};

type OrganizerRow = {
  id: string;
  name: string | null;
  slug: string | null;
};

type SlotRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  location_label: string | null;
  status: string;
  payment_status: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_notes: string | null;
  held_until: string | null;
};

export const metadata: Metadata = {
  title: "Guest Coach Schedule | DanceFlow",
  robots: {
    index: false,
    follow: false,
  },
};

const DEFAULT_EVENT_TIME_ZONE = "America/New_York";

function safeTimeZone(value: string | null | undefined) {
  const candidate = value || DEFAULT_EVENT_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_EVENT_TIME_ZONE;
  }
}

function formatTimeZoneLabel(timeZone: string) {
  return timeZone.replaceAll("_", " ");
}

function getDateParts(value: string, timeZone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = new Map(parts.map((part) => [part.type, part.value]));

  return {
    year: map.get("year") ?? "",
    month: map.get("month") ?? "",
    day: map.get("day") ?? "",
  };
}

function formatDate(value: string, timeZone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date coming soon";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatEventDate(value: string, timeZone: string) {
  return formatDate(`${value}T12:00:00`, timeZone);
}

function formatTime(value: string, timeZone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Time coming soon";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function slotDateKey(value: string, timeZone: string) {
  const parts = getDateParts(value, timeZone);

  if (!parts) {
    return "unknown";
  }

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function groupSlotsByDate(slots: SlotRow[], timeZone: string) {
  return slots.reduce<Record<string, SlotRow[]>>((groups, slot) => {
    const key = slotDateKey(slot.starts_at, timeZone);
    groups[key] = groups[key] ?? [];
    groups[key].push(slot);
    return groups;
  }, {});
}

function isCheckoutHold(slot: SlotRow) {
  return slot.status === "held" && Boolean(slot.held_until);
}

function isManualBlockedSlot(slot: SlotRow) {
  return slot.status === "held" && !isCheckoutHold(slot);
}

function statusLabel(slot: SlotRow) {
  if (slot.status === "booked") return "Booked";
  if (slot.status === "held") return isCheckoutHold(slot) ? "Checkout pending" : "Blocked";
  if (slot.status === "cancelled") return "Cancelled";
  return "Available";
}

function statusClassName(slot: SlotRow) {
  if (slot.status === "booked") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  }

  if (slot.status === "held") {
    return "bg-amber-50 text-amber-700 ring-amber-100";
  }

  if (slot.status === "cancelled") {
    return "bg-rose-50 text-rose-700 ring-rose-100";
  }

  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export default async function GuestCoachSchedulePage({
  params,
}: {
  params: Params;
}) {
  const { token } = await params;
  const normalizedToken = normalizePublicToken(token, {
    minLength: 24,
    maxLength: 128,
  });

  if (!normalizedToken) {
    notFound();
  }

  const supabase = await createClient();

  const { data: coach, error: coachError } = await supabase
    .from("event_guest_coaches")
    .select("id, event_id, studio_id, organizer_id, name, bio, photo_url, schedule_token_enabled, active")
    .eq("schedule_token", normalizedToken)
    .eq("active", true)
    .eq("schedule_token_enabled", true)
    .single();

  if (coachError || !coach) {
    notFound();
  }

  const typedCoach = coach as CoachRow;

  const nowIso = new Date().toISOString();

  await supabase
    .from("event_private_lesson_slots")
    .update({
      status: "available",
      payment_status: "unpaid",
      buyer_name: null,
      buyer_email: null,
      buyer_phone: null,
      buyer_notes: null,
      client_id: null,
      stripe_checkout_session_id: null,
      stripe_payment_intent_id: null,
      booked_at: null,
      held_until: null,
      hold_token: null,
      updated_at: nowIso,
    })
    .eq("coach_id", typedCoach.id)
    .eq("status", "held")
    .lt("held_until", nowIso);

  const [
    { data: event, error: eventError },
    { data: slots, error: slotsError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select(
        "id, name, slug, start_date, end_date, venue_name, city, state, timezone, status, visibility, public_directory_enabled, studio_id, organizer_id",
      )
      .eq("id", typedCoach.event_id)
      .single(),
    supabase
      .from("event_private_lesson_slots")
      .select(
        "id, starts_at, ends_at, location_label, status, payment_status, buyer_name, buyer_email, buyer_phone, buyer_notes, held_until",
      )
      .eq("coach_id", typedCoach.id)
      .in("status", ["held", "booked"])
      .order("starts_at", { ascending: true }),
  ]);

  if (eventError || !event || slotsError) {
    notFound();
  }

  const typedEvent = event as EventRow;
  const eventTimeZone = safeTimeZone(typedEvent.timezone);
  const eventTimeZoneLabel = formatTimeZoneLabel(eventTimeZone);

  const [{ data: studio }, { data: organizer }] = await Promise.all([
    typedEvent.studio_id
      ? supabase
          .from("studios")
          .select("id, name, slug, subscription_status")
          .eq("id", typedEvent.studio_id)
          .single()
      : Promise.resolve({ data: null }),
    typedEvent.organizer_id
      ? supabase
          .from("organizers")
          .select("id, name, slug")
          .eq("id", typedEvent.organizer_id)
          .single()
      : Promise.resolve({ data: null }),
  ]);

  const typedStudio = studio as StudioRow | null;
  const typedOrganizer = organizer as OrganizerRow | null;
  const typedSlots = ((slots ?? []) as SlotRow[])
    .filter((slot) => slot.status === "booked" || isManualBlockedSlot(slot))
    .slice()
    .sort((a, b) => {
      return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
    });

  const groupedSlots = groupSlotsByDate(typedSlots, eventTimeZone);
  const sortedDates = Object.keys(groupedSlots).sort();
  const bookedCount = typedSlots.filter((slot) => slot.status === "booked").length;
  const blockedCount = typedSlots.filter((slot) => isManualBlockedSlot(slot)).length;
  const hostName = typedStudio?.name || typedOrganizer?.name || "Event host";
  const eventLocation = [typedEvent.venue_name, typedEvent.city, typedEvent.state]
    .filter(Boolean)
    .join(" • ");
  const calendarPath = `/coach-schedule/${encodeURIComponent(normalizedToken)}/calendar`;
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
  const calendarUrl = siteUrl ? `${siteUrl}${calendarPath}` : calendarPath;
  const subscribeUrl = siteUrl
    ? calendarUrl.replace(/^https?:\/\//, "webcal://")
    : calendarPath;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <PublicSiteHeader />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="overflow-hidden rounded-[2rem] border border-[#E9D5FF] bg-white shadow-sm">
          <div className="bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] px-6 py-5 text-white sm:px-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-[#F3D7FF]">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-[10px] font-black tracking-normal text-[#5B197A]">
                DF
              </span>
              DanceFlow
            </div>
            <p className="mt-3 text-xs font-semibold uppercase tracking-[0.24em] text-[#F3D7FF]">
              Guest Coach Schedule
            </p>
          </div>

          <div className="p-6 sm:p-8">

          <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-start">
            <div>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                {typedCoach.name}
              </h1>
              <p className="mt-3 text-lg font-semibold text-slate-700">
                {typedEvent.name}
              </p>

              <div className="mt-4 space-y-1 text-sm leading-6 text-slate-600">
                <p>{hostName}</p>
                {eventLocation ? <p>{eventLocation}</p> : null}
                {typedEvent.start_date ? (
                  <p>
                    Event dates: {formatEventDate(typedEvent.start_date, eventTimeZone)}
                    {typedEvent.end_date && typedEvent.end_date !== typedEvent.start_date
                      ? ` – ${formatEventDate(typedEvent.end_date, eventTimeZone)}`
                      : ""}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 p-4 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-950">{bookedCount}</p>
                <p className="text-xs font-medium text-slate-500">Booked</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-950">{blockedCount}</p>
                <p className="text-xs font-medium text-slate-500">Blocked</p>
              </div>
            </div>
          </div>

            {typedCoach.bio ? (
              <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-600">
                {typedCoach.bio}
              </p>
            ) : null}
          </div>
        </section>

        <section className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Private Lesson Slots
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                This read-only schedule shows booked lessons and blocked time only. Open slots are hidden. All times are shown in {eventTimeZoneLabel}.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
              <a
                href={subscribeUrl}
                className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Subscribe to Calendar
              </a>
              <a
                href={calendarPath}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Download .ics
              </a>
              <Link
                href={`/events/${typedEvent.slug}`}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                View public event
              </Link>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Calendar feed</p>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Subscribe to add booked lessons and blocked time to your phone calendar. Open slots are hidden so your calendar stays focused. Times are published using the event timezone.
            </p>
            <p className="mt-3 break-all rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
              {calendarUrl}
            </p>
          </div>

          {sortedDates.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
              No booked lessons or blocked times are currently on this coach schedule.
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {sortedDates.map((dateKey) => {
                const daySlots = groupedSlots[dateKey];
                const dayBookedCount = daySlots.filter((slot) => slot.status === "booked").length;
                const dayBlockedCount = daySlots.filter((slot) => isManualBlockedSlot(slot)).length;

                return (
                  <details
                    key={dateKey}
                    className="group overflow-hidden rounded-2xl border border-slate-200 bg-slate-50"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 bg-white px-4 py-4 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-600">
                          {formatEventDate(dateKey, eventTimeZone)}
                        </h3>
                        <p className="mt-1 text-xs text-slate-500">
                          {daySlots.length} items • {dayBookedCount} booked • {dayBlockedCount} blocked
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:hidden">
                          Show
                        </span>
                        <span className="hidden rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 group-open:inline-flex">
                          Hide
                        </span>
                      </div>
                    </summary>

                    <div className="grid gap-3 border-t border-slate-200 p-4">
                      {daySlots.map((slot) => {
                      const isBooked = slot.status === "booked";
                      const isBlocked = isManualBlockedSlot(slot);

                      return (
                        <article
                          key={slot.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-base font-semibold text-slate-950">
                                {formatTime(slot.starts_at, eventTimeZone)} – {formatTime(slot.ends_at, eventTimeZone)}
                              </p>
                              {slot.location_label ? (
                                <p className="mt-1 text-sm text-slate-600">
                                  {slot.location_label}
                                </p>
                              ) : null}
                            </div>

                            <span
                              className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusClassName(
                                slot,
                              )}`}
                            >
                              {statusLabel(slot)}
                            </span>
                          </div>

                          {isBooked || isBlocked ? (
                            <div className="mt-4 rounded-xl bg-white p-4 text-sm leading-6 text-slate-700 ring-1 ring-slate-200">
                              {isBooked ? (
                                <>
                                  <p className="font-semibold text-slate-950">
                                    {slot.buyer_name || "Booked student"}
                                  </p>
                                  {slot.buyer_email ? <p>{slot.buyer_email}</p> : null}
                                  {slot.buyer_phone ? <p>{slot.buyer_phone}</p> : null}
                                </>
                              ) : (
                                <p className="font-semibold text-slate-950">Blocked time</p>
                              )}

                              {slot.buyer_notes ? (
                                <div className="mt-3 rounded-lg bg-slate-50 p-3">
                                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                    {isBlocked ? "Blocked reason" : "Notes"}
                                  </p>
                                  <p className="mt-1">{slot.buyer_notes}</p>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <PublicSiteFooter />
    </div>
  );
}
