import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
  price: number | string | null;
  location_label: string | null;
  status: string;
  payment_status: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_notes: string | null;
};

export const metadata: Metadata = {
  title: "Guest Coach Schedule | DanceFlow",
  robots: {
    index: false,
    follow: false,
  },
};

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Date coming soon";
  }

  return date.toLocaleDateString([], {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Time coming soon";
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatMoney(value: number | string | null) {
  const amount = Number(value ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return "Price not listed";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function groupSlotsByDate(slots: SlotRow[]) {
  return slots.reduce<Record<string, SlotRow[]>>((groups, slot) => {
    const key = new Date(slot.starts_at).toISOString().slice(0, 10);
    groups[key] = groups[key] ?? [];
    groups[key].push(slot);
    return groups;
  }, {});
}

function statusLabel(slot: SlotRow) {
  if (slot.status === "booked") return "Booked";
  if (slot.status === "held") return "Checkout pending";
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

  if (!token || token.length < 24) {
    notFound();
  }

  const supabase = await createClient();

  const { data: coach, error: coachError } = await supabase
    .from("event_guest_coaches")
    .select("id, event_id, studio_id, organizer_id, name, bio, photo_url, active")
    .eq("schedule_token", token)
    .eq("active", true)
    .single();

  if (coachError || !coach) {
    notFound();
  }

  const typedCoach = coach as CoachRow;

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
        "id, starts_at, ends_at, price, location_label, status, payment_status, buyer_name, buyer_email, buyer_phone, buyer_notes",
      )
      .eq("coach_id", typedCoach.id)
      .in("status", ["available", "held", "booked"])
      .order("starts_at", { ascending: true }),
  ]);

  if (eventError || !event || slotsError) {
    notFound();
  }

  const typedEvent = event as EventRow;

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
  const typedSlots = ((slots ?? []) as SlotRow[]).slice().sort((a, b) => {
    return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime();
  });

  const groupedSlots = groupSlotsByDate(typedSlots);
  const sortedDates = Object.keys(groupedSlots).sort();
  const bookedCount = typedSlots.filter((slot) => slot.status === "booked").length;
  const availableCount = typedSlots.filter((slot) => slot.status === "available").length;
  const hostName = typedStudio?.name || typedOrganizer?.name || "Event host";
  const eventLocation = [typedEvent.venue_name, typedEvent.city, typedEvent.state]
    .filter(Boolean)
    .join(" • ");

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <PublicSiteHeader />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--brand-accent-dark)]">
            Guest Coach Schedule
          </p>

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
                    Event dates: {formatDate(`${typedEvent.start_date}T00:00:00`)}
                    {typedEvent.end_date && typedEvent.end_date !== typedEvent.start_date
                      ? ` – ${formatDate(`${typedEvent.end_date}T00:00:00`)}`
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
                <p className="text-2xl font-bold text-slate-950">{availableCount}</p>
                <p className="text-xs font-medium text-slate-500">Open</p>
              </div>
            </div>
          </div>

          {typedCoach.bio ? (
            <p className="mt-5 max-w-3xl text-sm leading-7 text-slate-600">
              {typedCoach.bio}
            </p>
          ) : null}
        </section>

        <section className="mt-6 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                Private Lesson Slots
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                This read-only schedule updates as dancers book available slots.
              </p>
            </div>
            <Link
              href={`/events/${typedEvent.slug}`}
              className="inline-flex rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              View public event
            </Link>
          </div>

          {sortedDates.length === 0 ? (
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-500">
              No private lesson slots have been created for this coach yet.
            </div>
          ) : (
            <div className="mt-6 space-y-6">
              {sortedDates.map((dateKey) => (
                <div key={dateKey}>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
                    {formatDate(`${dateKey}T00:00:00`)}
                  </h3>

                  <div className="mt-3 grid gap-3">
                    {groupedSlots[dateKey].map((slot) => {
                      const isBooked = slot.status === "booked";

                      return (
                        <article
                          key={slot.id}
                          className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className="text-base font-semibold text-slate-950">
                                {formatTime(slot.starts_at)} – {formatTime(slot.ends_at)}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                                <span>{formatMoney(slot.price)}</span>
                                {slot.location_label ? (
                                  <>
                                    <span>•</span>
                                    <span>{slot.location_label}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>

                            <span
                              className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-semibold ring-1 ${statusClassName(
                                slot,
                              )}`}
                            >
                              {statusLabel(slot)}
                            </span>
                          </div>

                          {isBooked ? (
                            <div className="mt-4 rounded-xl bg-white p-4 text-sm leading-6 text-slate-700 ring-1 ring-slate-200">
                              <p className="font-semibold text-slate-950">
                                {slot.buyer_name || "Booked student"}
                              </p>
                              {slot.buyer_email ? <p>{slot.buyer_email}</p> : null}
                              {slot.buyer_phone ? <p>{slot.buyer_phone}</p> : null}
                              {slot.buyer_notes ? (
                                <div className="mt-3 rounded-lg bg-slate-50 p-3">
                                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                    Notes
                                  </p>
                                  <p className="mt-1">{slot.buyer_notes}</p>
                                </div>
                              ) : null}
                              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
                                Payment: {slot.payment_status}
                              </p>
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <PublicSiteFooter />
    </div>
  );
}
