import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { cancelFloorSpaceRentalAction } from "../actions";

type Params = Promise<{
  studioSlug: string;
}>;

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type RentalRow = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  rooms:
    | { name: string }
    | { name: string }[]
    | null;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function getRoomName(value: { name: string } | { name: string }[] | null) {
  const room = Array.isArray(value) ? value[0] : value;
  return room?.name ?? "No room selected";
}

function statusBadgeClass(status: string) {
  if (status === "scheduled") return "bg-blue-50 text-blue-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "attended") return "bg-green-50 text-green-700";
  if (status === "no_show") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "cancelled") {
    return {
      kind: "success" as const,
      message: "Floor rental cancelled.",
    };
  }

  if (search.success === "already_cancelled") {
    return {
      kind: "success" as const,
      message: "That floor rental was already cancelled.",
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

  if (search.error === "cancel_failed") {
    return {
      kind: "error" as const,
      message: "Could not cancel the floor rental.",
    };
  }

  return null;
}

export default async function MyFloorRentalsPage({
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select("id, first_name, last_name, is_independent_instructor")
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client || !client.is_independent_instructor) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const nowIso = new Date().toISOString();

  const [
    { data: upcomingRentals, error: upcomingError },
    { data: recentRentals, error: recentError },
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        rooms ( name )
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .eq("appointment_type", "floor_space_rental")
      .gte("starts_at", nowIso)
      .order("starts_at", { ascending: true }),

    supabase
      .from("appointments")
      .select(`
        id,
        title,
        starts_at,
        ends_at,
        status,
        rooms ( name )
      `)
      .eq("studio_id", studio.id)
      .eq("client_id", client.id)
      .eq("appointment_type", "floor_space_rental")
      .lt("starts_at", nowIso)
      .order("starts_at", { ascending: false })
      .limit(20),
  ]);

  if (upcomingError) {
    throw new Error(`Failed to load upcoming rentals: ${upcomingError.message}`);
  }

  if (recentError) {
    throw new Error(`Failed to load rental history: ${recentError.message}`);
  }

  const upcoming = (upcomingRentals ?? []) as RentalRow[];
  const recent = (recentRentals ?? []) as RentalRow[];
  const fullName = `${client.first_name} ${client.last_name}`.trim();

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

      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">{studio.name}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              My Rentals
            </h1>
            <p className="mt-2 text-slate-600">
              Review your upcoming and recent floor space rentals.
            </p>
            <p className="mt-2 text-sm text-slate-500">Signed in as {fullName}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(studio.slug)}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Portal
            </Link>

            <Link
              href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Book Floor Space
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Upcoming Rentals</p>
          <p className="mt-2 text-3xl font-semibold">{upcoming.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Recent Rental History</p>
          <p className="mt-2 text-3xl font-semibold">{recent.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Portal Access</p>
          <p className="mt-2 text-xl font-semibold">Independent Instructor</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">
              Upcoming Rentals
            </h2>

            {upcoming.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-slate-500">
                No upcoming floor rentals.
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                {upcoming.map((rental) => (
                  <div
                    key={rental.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="font-semibold text-slate-900">
                            {rental.title || "Floor Space Rental"}
                          </p>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(
                              rental.status
                            )}`}
                          >
                            {rental.status.replaceAll("_", " ")}
                          </span>
                        </div>

                        <p className="mt-3 text-sm text-slate-700">
                          {formatDate(rental.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatTime(rental.starts_at)} - {formatTime(rental.ends_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {getRoomName(rental.rooms)}
                        </p>
                      </div>

                      {rental.status !== "cancelled" ? (
                        <form action={cancelFloorSpaceRentalAction}>
                          <input type="hidden" name="studioSlug" value={studio.slug} />
                          <input type="hidden" name="appointmentId" value={rental.id} />
                          <input
                            type="hidden"
                            name="returnTo"
                            value={`/portal/${encodeURIComponent(
                              studio.slug
                            )}/floor-space/my-rentals`}
                          />
                          <button
                            type="submit"
                            className="rounded-xl border border-red-200 px-4 py-2 text-red-700 hover:bg-red-50"
                          >
                            Cancel Rental
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-900">
              Recent Rentals
            </h2>

            {recent.length === 0 ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-slate-500">
                No recent rental history.
              </div>
            ) : (
              <div className="mt-5 space-y-3">
                {recent.map((rental) => (
                  <div
                    key={rental.id}
                    className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {rental.title || "Floor Space Rental"}
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatDateTime(rental.starts_at)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {getRoomName(rental.rooms)}
                        </p>
                      </div>

                      <span
                        className={`rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wide ${statusBadgeClass(
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
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold">Quick Notes</h2>

            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>Floor space rentals do not deduct from lesson packages.</li>
              <li>Room assignment may be optional depending on studio setup.</li>
              <li>Only future rentals can be cancelled from this page.</li>
            </ul>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold">Quick Links</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Book Floor Space
              </Link>

              <Link
                href={`/portal/${encodeURIComponent(studio.slug)}`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Back to Portal Home
              </Link>
            </div>

            <form action="/auth/logout" method="post" className="mt-6">
              <button
                type="submit"
                className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
              >
                Log Out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}