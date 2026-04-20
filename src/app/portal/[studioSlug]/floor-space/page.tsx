import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
  if (
    search.success === "floor_rentals_booked" ||
    search.success === "booked"
  ) {
    return {
      kind: "success" as const,
      message: "Floor rentals booked successfully.",
    };
  }

  if (search.error === "cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the floor rental.",
    };
  }

  if (search.error === "missing_appointment") {
    return {
      kind: "error" as const,
      message: "Missing floor rental selection.",
    };
  }

  if (search.error === "not_found") {
    return {
      kind: "error" as const,
      message: "Floor rental not found.",
    };
  }

  if (search.error === "unauthorized") {
    return {
      kind: "error" as const,
      message: "You are not allowed to manage that floor rental.",
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
      message: "Past floor rentals cannot be cancelled here.",
    };
  }

  return null;
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

function formatTimeRange(start: string, end: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${fmt.format(new Date(start))} – ${fmt.format(new Date(end))}`;
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room selected";
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700 ring-1 ring-blue-100";
  if (status === "cancelled") return "bg-red-50 text-red-700 ring-1 ring-red-100";
  if (status === "attended") return "bg-green-50 text-green-700 ring-1 ring-green-100";
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
    .select("id, slug, name, public_name")
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

  const [{ data: rooms, error: roomsError }, { data: upcomingRentals, error: upcomingError }] =
    await Promise.all([
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

  const typedRooms = (rooms ?? []) as RoomOption[];
  const typedUpcomingRentals = (upcomingRentals ?? []) as UpcomingRentalRow[];
  const fullName =
    `${client.first_name ?? ""} ${client.last_name ?? ""}`.trim() || "Portal Member";
  const studioLabel = studio.public_name?.trim() || studio.name;

  return (
    <div className="space-y-8">
      {banner ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            banner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.message}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-[36px] border border-slate-200 bg-[linear-gradient(135deg,#ecfdf5_0%,#ffffff_45%,#f8fafc_100%)] p-8 shadow-sm sm:p-10">
        <div className="grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
              {studioLabel}
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Floor Space Rental
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
              Reserve studio time for practice, floor rental sessions, or instructor use.
              Room selection is optional when your studio allows it.
            </p>
            <p className="mt-3 text-sm text-slate-500">Signed in as {fullName}</p>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Available Rooms</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {typedRooms.length}
                </p>
              </div>

              <div className="rounded-2xl border border-sky-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Upcoming Rentals</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950">
                  {typedUpcomingRentals.length}
                </p>
              </div>

              <div className="rounded-2xl border border-violet-100 bg-white p-5 shadow-sm">
                <p className="text-sm text-slate-500">Portal Access</p>
                <p className="mt-2 text-xl font-semibold text-slate-950">
                  Independent Instructor
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">
              Quick Actions
            </p>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">My Rentals</p>
                <p className="mt-1 text-sm text-slate-600">
                  Review upcoming rentals and recent rental history.
                </p>
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studioSlug)}`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">Portal Home</p>
                <p className="mt-1 text-sm text-slate-600">
                  Return to your instructor dashboard.
                </p>
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studioSlug)}/profile`}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-5 hover:bg-slate-100"
              >
                <p className="font-medium text-slate-900">My Profile</p>
                <p className="mt-1 text-sm text-slate-600">
                  Review your linked instructor portal profile.
                </p>
              </Link>
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
              Add one or more future time slots, optionally choose a room, and review conflicts before submitting.
            </p>
          </div>

          <div className="mt-6">
            <FloorSpaceRentalForm studioSlug={studioSlug} rooms={typedRooms} />
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
                  Your next rentals will appear here once you book them.
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
                          {formatDateTime(rental.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatTimeRange(rental.starts_at, rental.ends_at)}
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
              Before You Book
            </p>

            <ul className="mt-5 space-y-3 text-sm leading-7 text-slate-700">
              <li>Book only the time you need.</li>
              <li>Floor rentals do not deduct from lesson packages.</li>
              <li>Only future rentals can be cancelled from the rentals page.</li>
              <li>Room selection may be optional depending on studio setup.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}