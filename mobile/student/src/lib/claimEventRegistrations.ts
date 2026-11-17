import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";

/*
  Event-ticket visibility (proposal #596, Option A): the database function
  claim_my_event_registrations() links the signed-in user's event registrations
  to their account by VERIFIED email and returns how many it linked (an integer).
  The app passes nothing: the function decides from the live session.

  Rules the app keeps:
  - Fail closed and silent. Any error (including the function not existing yet,
    PostgREST PGRST202) means "claimed nothing": no message, no retry.
  - At most one call per signed-in user per app run. The attempt is recorded
    before the call, so an error never causes a retry loop, and two screens that
    ask at the same time share one call.
  - Signed out: no call.
*/

const attempts = new Map<string, Promise<number>>();

/** The few fields of the auth user the pre-check reads (a Supabase User has them). */
export type ClaimUser = { id?: string | null; email?: string | null; email_confirmed_at?: string | null } | null | undefined;

/**
 * Only a signed-in user whose email is confirmed is worth asking for. This is a cheap pre-check, not the security
 * check: the database decides from the live session (verified and bound email) and returns 0 otherwise.
 */
export function claimEligibleUserId(user: ClaimUser): string | null {
  if (!user?.id || !user.email || !user.email_confirmed_at) return null;
  return user.id;
}

/** Tests only: forget which users were already asked. */
export function resetClaimAttemptsForTests() {
  attempts.clear();
}

function toCount(data: unknown): number {
  return typeof data === "number" && Number.isInteger(data) && data > 0 ? data : 0;
}

export function claimMyEventRegistrations(userId: string | null | undefined): Promise<number> {
  if (!userId) return Promise.resolve(0);

  const existing = attempts.get(userId);
  if (existing) return existing;

  const attempt = (async () => {
    try {
      const { data, error } = await supabase.rpc("claim_my_event_registrations");
      if (error) return 0;
      return toCount(data);
    } catch {
      return 0;
    }
  })();

  attempts.set(userId, attempt);
  return attempt;
}

/**
 * Asks once per user (shared across screens) and calls onClaimed when the count
 * is above zero, so the screen can reload its tickets. Never blocks a load.
 */
export function useClaimEventRegistrations(user: ClaimUser, onClaimed: (count: number) => void) {
  const userId = claimEligibleUserId(user);
  const onClaimedRef = useRef(onClaimed);

  useEffect(() => {
    onClaimedRef.current = onClaimed;
  });

  useEffect(() => {
    if (!userId) return;
    let active = true;
    void claimMyEventRegistrations(userId).then((count) => {
      if (active && count > 0) onClaimedRef.current(count);
    });
    return () => {
      active = false;
    };
  }, [userId]);
}
