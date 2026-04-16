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

function getBanner(search: { success?: string; error?: string }) {
  if (search.success === "floor_rentals_booked") {
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
    .select("id, slug, name")
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

  const { data: rooms, error: roomsError } = await supabase
    .from("rooms")
    .select("id, name")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .order("name", { ascending: true });

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  const typedRooms = (rooms ?? []) as RoomOption[];
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
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">{studio.name}</p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Floor Space Rental
            </h1>
            <p className="mt-2 text-slate-600">
              Book one or more floor rental time slots. Room selection is optional based on studio setup.
            </p>
            <p className="mt-2 text-sm text-slate-500">Signed in as {fullName}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(studioSlug)}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Portal
            </Link>
            <Link
              href={`/portal/${encodeURIComponent(studioSlug)}/floor-space/my-rentals`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              My Rentals
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Booking Type</p>
          <p className="mt-2 text-xl font-semibold">Floor Space Rental</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Package Deduction</p>
          <p className="mt-2 text-xl font-semibold">No</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Room Selection</p>
          <p className="mt-2 text-xl font-semibold">
            {typedRooms.length > 0 ? "Optional" : "Not required"}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <FloorSpaceRentalForm studioSlug={studioSlug} rooms={typedRooms} />
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Before You Book</h2>

        <ul className="mt-4 space-y-2 text-sm text-slate-600">
          <li>Book only the time you need.</li>
          <li>Floor rentals do not deduct from lesson packages.</li>
          <li>Only future rentals can be cancelled from the rentals page.</li>
        </ul>
      </div>
    </div>
  );
}