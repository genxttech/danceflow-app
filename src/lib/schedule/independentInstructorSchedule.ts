import { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// FC-1B2: appointment statuses that legitimately occupy a room, mirroring
// the active-status set already established by detectAppointmentConflicts
// (src/lib/schedule/conflicts.ts). Kept as a local literal here rather than
// importing/exporting a shared constant -- this is a read-only visibility
// projection, not the booking-conflict engine itself (that stays FC-1B3's
// concern), and duplicating one small literal avoids coupling the two.
const ROOM_OCCUPYING_STATUSES = ["scheduled", "confirmed", "rescheduled", "attended"];

export type OwnFloorRentalRow = {
  id: string;
  title: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  payment_status: string | null;
  price_amount: number | string | null;
  rooms: { name: string } | { name: string }[] | null;
};

export type AnonymizedBusyBlock = {
  key: string;
  room_id: string;
  room_name: string;
  starts_at: string;
  ends_at: string;
  label: "Busy" | "Unavailable";
};

/**
 * FC-1B2 own-rental determination: the SAME relationship dimensions FC-1
 * established for verifying a submitted clientId belongs to this user
 * (studio-scoped client_account_links, status='linked') -- here used to
 * DISCOVER the client id(s) rather than verify one. Never derived from a
 * client-supplied id, display name, instructor name, or created_by.
 */
export async function resolveOwnFloorRentalClientIds(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  userId: string;
}): Promise<string[]> {
  const { supabase, studioId, userId } = params;

  const { data, error } = await supabase
    .from("client_account_links")
    .select("client_id")
    .eq("studio_id", studioId)
    .eq("user_id", userId)
    .eq("status", "linked");

  if (error || !data) return [];

  return Array.from(
    new Set(
      data
        .map((row) => (row as { client_id: string | null }).client_id)
        .filter((clientId): clientId is string => Boolean(clientId)),
    ),
  );
}

/**
 * Own floor-rental appointments in full -- the same field shape already
 * shown to this same person on the portal My Rentals surface
 * (src/app/portal/[studioSlug]/floor-space/my-rentals/page.tsx), which
 * remains the canonical "what may an independent instructor see about
 * their own rental" precedent.
 */
export async function getOwnFloorRentalAppointments(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  ownClientIds: string[];
  nowIso: string;
  rangeEndIso: string;
  recentLimit?: number;
}): Promise<{ upcoming: OwnFloorRentalRow[]; recent: OwnFloorRentalRow[] }> {
  const { supabase, studioId, ownClientIds, nowIso, rangeEndIso, recentLimit = 10 } = params;

  if (ownClientIds.length === 0) {
    return { upcoming: [], recent: [] };
  }

  const selectClause = `
    id,
    title,
    starts_at,
    ends_at,
    status,
    payment_status,
    price_amount,
    rooms ( name )
  `;

  const [{ data: upcoming, error: upcomingError }, { data: recent, error: recentError }] =
    await Promise.all([
      // FC-1B2 revision: capped to the same forward horizon as the
      // anonymized occupancy query below (rangeEndIso) -- own rentals and
      // room occupancy must never drift apart, or an instructor could see
      // their own rental in a date range the Busy/Unavailable signal
      // doesn't cover. Rentals beyond this horizon remain reachable via
      // Manage My Rentals (the portal), which is unbounded.
      supabase
        .from("appointments")
        .select(selectClause)
        .eq("studio_id", studioId)
        .in("client_id", ownClientIds)
        .eq("appointment_type", "floor_space_rental")
        .gte("starts_at", nowIso)
        .lt("starts_at", rangeEndIso)
        .order("starts_at", { ascending: true }),
      supabase
        .from("appointments")
        .select(selectClause)
        .eq("studio_id", studioId)
        .in("client_id", ownClientIds)
        .eq("appointment_type", "floor_space_rental")
        .lt("starts_at", nowIso)
        .order("starts_at", { ascending: false })
        .limit(recentLimit),
    ]);

  if (upcomingError) {
    throw new Error(`Failed to load your upcoming rentals: ${upcomingError.message}`);
  }

  if (recentError) {
    throw new Error(`Failed to load your rental history: ${recentError.message}`);
  }

  return {
    upcoming: (upcoming ?? []) as OwnFloorRentalRow[],
    recent: (recent ?? []) as OwnFloorRentalRow[],
  };
}

/**
 * Anonymized room-occupancy signal for everything that is NOT one of this
 * user's own already-fully-visible floor-rental rows -- appointments and
 * instructor schedule blocks are projected down to room + time only
 * server-side. No client identity, instructor identity, appointment type,
 * notes, payment, or package data is ever selected here, so there is
 * nothing sensitive to strip in the render -- this is a query-shape
 * privacy boundary, not a UI one.
 *
 * FC-1B2 revision: exclusion is by the OWN rental appointments' own ids
 * (already fetched via getOwnFloorRentalAppointments, over the identical
 * window), not by client id. Excluding by client id was wrong -- it made
 * ANY appointment on the instructor's linked client record vanish
 * entirely, including a hypothetical non-floor-rental appointment on that
 * same client, which must still surface as generic Busy occupancy (it
 * genuinely occupies a room) even though it is not itself an own rental.
 */
export async function getAnonymizedBusyOccupancy(params: {
  supabase: SupabaseServerClient;
  studioId: string;
  excludeAppointmentIds: string[];
  rangeStartIso: string;
  rangeEndIso: string;
}): Promise<AnonymizedBusyBlock[]> {
  const { supabase, studioId, excludeAppointmentIds, rangeStartIso, rangeEndIso } = params;

  let appointmentsQuery = supabase
    .from("appointments")
    .select("starts_at, ends_at, rooms ( id, name )")
    .eq("studio_id", studioId)
    .in("status", ROOM_OCCUPYING_STATUSES)
    .not("room_id", "is", null)
    .lt("starts_at", rangeEndIso)
    .gt("ends_at", rangeStartIso);

  if (excludeAppointmentIds.length > 0) {
    appointmentsQuery = appointmentsQuery.not(
      "id",
      "in",
      `(${excludeAppointmentIds.join(",")})`,
    );
  }

  const [{ data: busyAppointments, error: appointmentsError }, { data: busyBlocks, error: blocksError }] =
    await Promise.all([
      appointmentsQuery,
      supabase
        .from("instructor_schedule_blocks")
        .select("starts_at, ends_at, rooms ( id, name )")
        .eq("studio_id", studioId)
        .not("room_id", "is", null)
        .lt("starts_at", rangeEndIso)
        .gt("ends_at", rangeStartIso),
    ]);

  if (appointmentsError) {
    throw new Error(`Failed to load room occupancy: ${appointmentsError.message}`);
  }

  if (blocksError) {
    throw new Error(`Failed to load room occupancy: ${blocksError.message}`);
  }

  function toEntries(
    rows: { starts_at: string; ends_at: string; rooms: { id?: string; name: string } | { id?: string; name: string }[] | null }[] | null,
    label: "Busy" | "Unavailable",
  ): AnonymizedBusyBlock[] {
    return (rows ?? [])
      .map((row) => {
        const room = Array.isArray(row.rooms) ? row.rooms[0] : row.rooms;
        if (!room?.id) return null;

        return {
          key: `${label}-${room.id}-${row.starts_at}-${row.ends_at}`,
          room_id: room.id,
          room_name: room.name,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          label,
        } satisfies AnonymizedBusyBlock;
      })
      .filter((entry): entry is AnonymizedBusyBlock => entry !== null);
  }

  return [
    ...toEntries(busyAppointments, "Busy"),
    ...toEntries(busyBlocks, "Unavailable"),
  ].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
