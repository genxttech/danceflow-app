import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganizerPlatformFeePercent } from "@/lib/events/platformFee";

/*
  D7 owner decision P2-3 (extended to every in-person method): a NEW Terminal (card reader) or manual in-person ticket sale for an event run by an organizer needs a current
  Organizer Suite entitlement, decided exactly like the online event checkouts (platform-fee tier above 0: the organizer
  plan, or a current Suite entitlement under the shared period_end boundary rule).

  This is a gate only. Terminal fee behavior is unchanged: the reader PaymentIntent carries no DanceFlow application
  fee, and no online Organizer Suite fee percentage is applied to Terminal transactions (that needs a separate
  owner-approved fee policy). Ordinary studio events (no organizer_id) are never gated. Payments that were already
  collected, their fulfillment, ticket redemption and check-in are never evaluated here.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const TERMINAL_ORGANIZER_SUITE_ERROR_CODE = "terminal_organizer_suite_required";

export const TERMINAL_ORGANIZER_SUITE_MESSAGE =
  "This organizer is not accepting new ticket sales for this event right now, so the card reader was not started. Nothing was charged.";

/** Shown when staff try to record a NEW in-person ticket sale (any payment method) for an organizer event. */
export const IN_PERSON_ORGANIZER_SUITE_MESSAGE =
  "This organizer is not accepting new ticket sales for this event right now. Nothing was charged or recorded.";

/**
 * True when a new Terminal sale for this event must be refused. `admin` must be a service-role client: front-desk and
 * organizer-staff sessions cannot read usage_addon_entitlements through row-level security.
 */
export async function terminalSaleNeedsOrganizerSuite(
  admin: Db,
  params: { studioId: string; organizerId: string | null | undefined },
): Promise<boolean> {
  if (!params.organizerId) return false;
  return (await getOrganizerPlatformFeePercent(admin, params.studioId)) <= 0;
}
