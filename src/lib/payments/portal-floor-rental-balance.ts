import type { createClient } from "@/lib/supabase/server";

type PortalSupabaseClient = Awaited<ReturnType<typeof createClient>>;

export type PayableFloorRentalAppointment = {
  id: string;
  price_amount: number;
};

/**
 * The single definition of "which floor-rental appointments count toward a
 * client's collectible balance," shared by the portal My Rentals page
 * (display) and the portal floor-rental checkout route (what actually gets
 * charged). Before this helper existed, the page computed its Balance Due
 * from a separate `starts_at >= now()`-filtered query while the checkout
 * route queried with no date restriction at all -- the two could (and did,
 * in QA on PR #11) disagree about the payable total for the same client,
 * showing one amount on screen while charging a different one. Routing both
 * call sites through this one function makes that class of drift
 * impossible by construction rather than something that has to be kept in
 * sync by convention.
 *
 * Deliberately has no `starts_at` filter: a floor rental does not stop
 * being owed just because its date has passed -- the same "unpaid
 * regardless of date" rule already used for pay-as-you-go lesson balances
 * on the staff-facing client detail page
 * (`src/app/app/clients/[id]/page.tsx`'s `unpaidPayAsYouGoLessons`, which
 * concatenates upcoming and recent appointments before filtering).
 *
 * `payment_status` is matched via `.in(['unpaid','partial'])` only --
 * no `== null` fallback -- because `appointments.payment_status` is
 * `NOT NULL DEFAULT 'unpaid'` in the schema; a real NULL can never occur,
 * so there is nothing for a null-handling branch to ever match.
 */
export async function getPayableFloorRentalAppointments(params: {
  supabase: PortalSupabaseClient;
  studioId: string;
  clientId: string;
}): Promise<PayableFloorRentalAppointment[]> {
  const { supabase, studioId, clientId } = params;

  const { data, error } = await supabase
    .from("appointments")
    .select("id, price_amount")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("appointment_type", "floor_space_rental")
    .neq("status", "cancelled")
    .in("payment_status", ["unpaid", "partial"])
    .order("starts_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load payable floor rentals: ${error.message}`);
  }

  return (data ?? [])
    .filter((row) => Number(row.price_amount ?? 0) > 0)
    .map((row) => ({ id: row.id as string, price_amount: Number(row.price_amount) }));
}
