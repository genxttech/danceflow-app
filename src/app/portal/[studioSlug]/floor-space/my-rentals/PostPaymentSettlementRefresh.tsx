"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { scheduleSettlementRefresh } from "./settlementRefreshPolicy";

type Props = {
  /** The raw `success` query value from the URL, exactly as read on this
   * server render -- only activates polling on an exact
   * `balance_payment_submitted` match. */
  success: string | undefined;
  /** Whether this render's own payable-balance read already shows the
   * balance settled (e.g. `unpaidRentalCount === 0`). Passed down from the
   * server component rather than re-derived here -- this component never
   * computes or fabricates payment state of its own. */
  isSettled: boolean;
};

/**
 * Renders nothing. Its only job is to call `router.refresh()` a bounded
 * number of times after a floor-rental balance payment redirect, so the
 * My Rentals page settles to the real paid state without a manual browser
 * reload if the webhook hasn't landed yet at the moment of the first
 * render. See settlementRefreshPolicy.ts for the actual policy (exact
 * success-flag match, settled short-circuit, attempt cap) -- this
 * component only wires that policy to React's effect/ref lifecycle.
 */
export function PostPaymentSettlementRefresh({ success, isSettled }: Props) {
  const router = useRouter();
  const attemptsRef = useRef(0);

  useEffect(() => {
    return scheduleSettlementRefresh({
      success,
      isSettled,
      attemptsSoFar: attemptsRef.current,
      onRefresh: () => {
        attemptsRef.current += 1;
        router.refresh();
      },
    });
  }, [success, isSettled, router]);

  return null;
}
