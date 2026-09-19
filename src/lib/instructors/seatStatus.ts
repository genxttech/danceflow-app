import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Landmark 1A Slice 8 -- derived instructor-seat status for UI notices.
 *
 * The authoritative numbers come from the DB (get_instructor_seat_status):
 * effective limit via the single SQL resolver, counted usage via the single
 * counted-seat predicate. Over-limit is DERIVED from those two live values --
 * never stored -- so it cannot go stale. This module only reads and words it.
 */
export type InstructorSeatStatus = {
  seatLimit: number;
  countedUsage: number;
  overLimit: boolean;
};

type SeatStatusRow = {
  seat_limit: number;
  counted_usage: number;
  over_limit: boolean;
};

/**
 * Returns the derived status, or null when it cannot be read (not staff,
 * RPC not yet deployed, transient error). Callers must treat null as "show
 * nothing" -- the notice is informational; enforcement lives in the DB.
 */
export async function getInstructorSeatStatus(
  supabase: SupabaseClient,
  studioId: string,
): Promise<InstructorSeatStatus | null> {
  const { data, error } = await supabase.rpc("get_instructor_seat_status", {
    p_studio_id: studioId,
  });

  if (error || !data) return null;

  const row = (Array.isArray(data) ? data[0] : data) as SeatStatusRow | undefined;
  if (!row || typeof row.seat_limit !== "number") return null;

  return {
    seatLimit: row.seat_limit,
    countedUsage: row.counted_usage,
    overLimit: row.over_limit === true,
  };
}

export type InstructorSeatNoticeCopy = {
  kind: "plan" | "inactive_subscription";
  title: string;
  body: string;
};

/**
 * One concise notice, only when usage exceeds the limit. A limit of 0 means
 * the studio has no active seat entitlement (inactive/cancelled/not-started
 * subscription, or a plan without instructor seats) -- worded as a billing
 * status, not as a customer who chose a zero-seat plan.
 */
export function describeInstructorSeatNotice(
  status: InstructorSeatStatus | null,
): InstructorSeatNoticeCopy | null {
  if (!status || !status.overLimit) return null;

  const freeze =
    "Existing instructors keep working, but you can't add or reactivate instructors until usage fits your plan.";

  if (status.seatLimit === 0) {
    return {
      kind: "inactive_subscription",
      title: "Instructor seats are unavailable while billing is inactive",
      body: `This studio's subscription isn't active, so no instructor seats are currently included (${status.countedUsage} in use). Existing instructors keep working, but you can't add or reactivate instructors until billing is active.`,
    };
  }

  const seats = status.seatLimit === 1 ? "1 instructor seat" : `${status.seatLimit} instructor seats`;

  return {
    kind: "plan",
    title: "You're over your plan's instructor seats",
    body: `Your current plan includes ${seats}, but ${status.countedUsage} ${
      status.countedUsage === 1 ? "is" : "are"
    } in use. ${freeze}`,
  };
}
