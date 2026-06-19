import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FloorSpaceRentalForm from "./FloorSpaceRentalForm";

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type RoomOption = {
  id: string;
  name: string;
};

type UpcomingRentalRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  rooms:
    | { name: string }
    | { name: string }[]
    | null;
};

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "floor_rentals_booked" || search.success === "booked") {
    return {
      kind: "success" as const,
      message: "Your floor rental was booked.",
    };
  }

  if (search.error === "cancel_failed") {
    return {
      kind: "error" as const,
      message: "We could not cancel that floor rental.",
    };
  }

  if (search.error === "missing_appointment") {
    return {
      kind: "error" as const,
      message: "Please choose a floor rental first.",
    };
  }

  if (search.error === "not_found") {
    return {
      kind: "error" as const,
      message: "We could not find that floor rental.",
    };
  }

  if (search.error === "unauthorized") {
    return {
      kind: "error" as const,
      message: "You do not have access to manage that floor rental.",
    };
  }

  if (search.error === "invalid_type") {
    return {
      kind: "error" as const,
      message: "That booking is not a floor rental.",
    };
  }

  if (search.error === "past_rental") {
    return {
      kind: "error" as const,
      message: "Past rentals cannot be cancelled here.",
    };
  }

  return null;
}


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
    timeZone: getStudioTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const hourValue = Number(lookup.get("hour") ?? "0");

  return {
    year: lookup.get("year") ?? "0000",
    month: lookup.get("month") ?? "01",
    day: lookup.get("day") ?? "01",
    hour: String(hourValue === 24 ? 0 : hourValue).padStart(2, "0"),
    minute: lookup.get("minute") ?? "00",
    second: lookup.get("second") ?? "00",
  };
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtcDate(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour = 0, minute = 0, second = 0] = time.split(":").map(Number);

  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);

  for (let i = 0; i < 2; i += 1) {
    const offsetMs = getZonedOffsetMs(new Date(utcMs), timeZone);
    utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMs;
  }

  return new Date(utcMs);
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  return zonedDateTimeToUtcDate(date, time, timeZone).toISOString();
}

function getZonedDateKey(value: Date | string, timeZone: string) {
  const parts = getZonedDateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return date.toISOString().slice(0, 10);
}

function formatStudioDate(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(new Date(value));
}

function formatStudioDateTime(value: string | null | undefined, timeZone: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";

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
  if (!value) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: getStudioTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string, timeZone: string) {
  return formatStudioDateTime(value, timeZone, { weekday: "short" });
}

function formatTimeRange(start: string, end: string, timeZone: string) {
  return `${formatStudioTime(start, timeZone)} – ${formatStudioTime(end, timeZone)}`;
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room selected";
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "cancelled") return "bg-rose-50 text-rose-700 ring-1 ring-rose-100";
  if (status === "attended") return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100";
  if (status === "no_show") return "bg-amber-50 text-amber-700 ring-1 ring-amber-100";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

export default async function FloorSpacePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { studioSlug } = await params;
  const query = await searchParams;
  const banner = getBanner(query);

  const supabase = await createClient();

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, slug, name, public_name, timezone")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    notFound();
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}`);
  }

  if (!client.is_independent_instructor) {
    redirect(`/portal/${encodeURIComponent(studioSlug)}`);
  }

  
  const nowIso = new Date().toISOString();

  const [
    { data: rooms, error: roomsError },
    { data: upcomingRentals, error: upcomingError },
  ] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("appointments")
      .select(`
        id,
        starts_at,
        ends_at,
        status,
        rooms ( name )
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .eq("appointment_type", "floor_space_rental")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true })
      .limit(3),
  ]);

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  if (upcomingError) {
    throw new Error(`Failed to load upcoming rentals: ${upcomingError.message}`);
  }

  const studioTimeZone = getStudioTimeZone(studio.timezone);
  const typedRooms = (rooms ?? []) as RoomOption[];
  const typedUpcomingRentals = (upcomingRentals ?? []) as UpcomingRentalRow[];
  const fullName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Portal Member";
  const studioLabel = studio.public_name?.trim() || studio.name;

  return (
    <div className="space-y-8">
      {banner ? (
        <section
          className={`rounded-[28px] border p-5 shadow-sm ${
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <p className="text-sm font-semibold uppercase tracking-[0.16em]">
            {banner.kind === "success" ? "Rental Updated" : "Rental Problem"}
          </p>
          <p className="mt-2 text-sm leading-7">{banner.message}</p>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Portal
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Book Floor Space
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Reserve studio time for practice or floor rental sessions and keep your upcoming rentals in one place.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm text-white/80">
                <span>
                  Studio: <span className="font-medium text-white">{studioLabel}</span>
                </span>
                <span>
                  Signed in as: <span className="font-medium text-white">{fullName}</span>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
  <Link
    href={`/portal/${encodeURIComponent(studioSlug)}`}
    className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
  >
    Portal Home
  </Link>
</div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">
                Pick your time carefully
              </h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Choose the date and time you need so your rental matches your actual studio use.
              </p>
            </div>

            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">
                Add a room when needed
              </h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                If your studio uses rooms, choose the right one so your rental is easier to track.
              </p>
            </div>

            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                Check upcoming rentals
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Use the upcoming rentals panel to review what is already booked before adding more time.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-8 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">
              Book Rental Time
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Choose your studio time
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              Add one or more future time slots, choose a room if needed, and send your request.
            </p>
          </div>

          <div className="mt-6">
            <FloorSpaceRentalForm studioSlug={studioSlug} rooms={typedRooms} studioTimeZone={studioTimeZone} />
          </div>
        </section>

        <div className="space-y-8">
          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-sky-700">
              Upcoming Rentals
            </p>

            {typedUpcomingRentals.length === 0 ? (
              <div className="mt-6 rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
                <p className="text-lg font-medium text-slate-900">No rentals booked yet</p>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  Your next rentals will show here after you book them.
                </p>
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {typedUpcomingRentals.map((rental) => (
                  <div
                    key={rental.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {formatDateTime(rental.starts_at, studioTimeZone)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatTimeRange(rental.starts_at, rental.ends_at, studioTimeZone)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {getRoomName(rental.rooms)}
                        </p>
                      </div>

                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(
                          rental.status
                        )}`}
                      >
                        {rental.status.replaceAll("_", " ")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5">
              <Link
                href={`/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                View All Rentals
              </Link>
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-orange-600">
              Helpful Tips
            </p>

            <ul className="mt-5 space-y-3 text-sm leading-7 text-slate-700">
              <li>Book only the time you plan to use.</li>
              <li>Floor rentals are separate from lesson packages.</li>
              <li>Only future rentals can be cancelled from the rentals page.</li>
              <li>Room choice may be optional depending on studio setup.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}