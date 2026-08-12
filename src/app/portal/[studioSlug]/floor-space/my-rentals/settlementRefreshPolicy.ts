/**
 * Post-payment settlement refresh: closes the race between Stripe's
 * success redirect and webhook-driven fulfillment on the My Rentals page.
 * The page is already dynamically server-rendered with fresh data on every
 * request -- this is not a caching problem. The gap is purely timing: the
 * browser can land back on this page before the `checkout.session.completed`
 * webhook's writes have committed, and nothing previously re-checked after
 * that first read. This module decides, given the current server-rendered
 * state, whether one more `router.refresh()` should be scheduled to give
 * the webhook a little more time to land -- it never fabricates a paid
 * state itself; it only ever triggers a fresh server read.
 */

const SUCCESS_FLAG = "balance_payment_submitted";

/** How long to wait between settlement re-checks. Modest on purpose --
 * webhook delivery for this flow normally lands well under a second in
 * production and within a couple of seconds in the worst case seen so far;
 * this is not meant to out-wait a genuinely broken/delayed webhook, only
 * the ordinary redirect-vs-webhook race. */
export const SETTLEMENT_REFRESH_INTERVAL_MS = 2000;

/** Hard cap on how many refreshes this will ever perform for one page
 * visit. 5 attempts at the interval above bounds the total polling window
 * to about 10 seconds -- long enough to comfortably outlast the ordinary
 * race, short enough that a user is never left refreshing indefinitely.
 * Once this is reached with the balance still unpaid, polling stops and
 * the real (still-unpaid) server-rendered state is left exactly as is. */
export const MAX_SETTLEMENT_REFRESH_ATTEMPTS = 5;

export type SettlementRefreshDecision =
  | { shouldSchedule: true; delayMs: number }
  | { shouldSchedule: false };

/**
 * Pure decision: given the exact success flag from the URL, whether the
 * page's own payable-balance read already shows settlement, and how many
 * refreshes have already been performed this visit, should one more
 * refresh be scheduled -- and after how long.
 *
 * Deliberately activates on an *exact* match of the success flag, not any
 * truthy `success` value -- a cancelled/failed checkout
 * (`error=checkout_cancelled`, etc.) or an unrelated success state must
 * never trigger polling.
 */
export function decideSettlementRefresh(params: {
  success: string | undefined;
  isSettled: boolean;
  attemptsSoFar: number;
  intervalMs?: number;
  maxAttempts?: number;
}): SettlementRefreshDecision {
  const {
    success,
    isSettled,
    attemptsSoFar,
    intervalMs = SETTLEMENT_REFRESH_INTERVAL_MS,
    maxAttempts = MAX_SETTLEMENT_REFRESH_ATTEMPTS,
  } = params;

  if (success !== SUCCESS_FLAG) return { shouldSchedule: false };
  if (isSettled) return { shouldSchedule: false };
  if (attemptsSoFar >= maxAttempts) return { shouldSchedule: false };

  return { shouldSchedule: true, delayMs: intervalMs };
}

/**
 * Schedules (or skips) exactly one settlement-refresh timer, mirroring
 * what a React effect keyed on `[success, isSettled]` should do on every
 * render: consult `decideSettlementRefresh`, and if it says to schedule,
 * start a single `setTimeout` that calls `onRefresh` once. Always returns
 * a cleanup function safe to call unconditionally -- a no-op if nothing was
 * scheduled -- matching a React effect's own cleanup contract exactly, so
 * the caller (a `useEffect`) can return this directly and get correct
 * unmount/dependency-change cleanup for free.
 *
 * This is the one place the actual timer lives; the React component below
 * is a thin wrapper around this function, not a second implementation of
 * the same policy.
 */
export function scheduleSettlementRefresh(params: {
  success: string | undefined;
  isSettled: boolean;
  attemptsSoFar: number;
  onRefresh: () => void;
  intervalMs?: number;
  maxAttempts?: number;
}): () => void {
  const decision = decideSettlementRefresh(params);
  if (!decision.shouldSchedule) return () => {};

  const timer = setTimeout(params.onRefresh, decision.delayMs);
  return () => clearTimeout(timer);
}
