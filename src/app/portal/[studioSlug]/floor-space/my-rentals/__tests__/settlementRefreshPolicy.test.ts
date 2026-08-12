import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  decideSettlementRefresh,
  scheduleSettlementRefresh,
  SETTLEMENT_REFRESH_INTERVAL_MS,
  MAX_SETTLEMENT_REFRESH_ATTEMPTS,
} from "../settlementRefreshPolicy";

/**
 * Regression coverage for the My Rentals post-payment settlement refresh:
 * closes the race between Stripe's success redirect and webhook-driven
 * fulfillment without adding Next.js caching/revalidation (there is no
 * cache to invalidate -- the page is already dynamically rendered) and
 * without ever fabricating a paid state client-side -- every scheduled
 * refresh only ever triggers a real server re-read via the `onRefresh`
 * callback (in the real component, `router.refresh()`).
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("decideSettlementRefresh", () => {
  it("does not schedule when the success flag is absent", () => {
    const decision = decideSettlementRefresh({
      success: undefined,
      isSettled: false,
      attemptsSoFar: 0,
    });

    expect(decision).toEqual({ shouldSchedule: false });
  });

  it("does not schedule for a cancelled/failed checkout query state", () => {
    const decision = decideSettlementRefresh({
      success: "checkout_cancelled",
      isSettled: false,
      attemptsSoFar: 0,
    });

    expect(decision).toEqual({ shouldSchedule: false });
  });

  it("does not schedule for an unrelated success flag value", () => {
    const decision = decideSettlementRefresh({
      success: "no_balance_due",
      isSettled: false,
      attemptsSoFar: 0,
    });

    expect(decision).toEqual({ shouldSchedule: false });
  });

  it("does not schedule when the success flag is present but the balance is already settled", () => {
    const decision = decideSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: true,
      attemptsSoFar: 0,
    });

    expect(decision).toEqual({ shouldSchedule: false });
  });

  it("schedules a bounded refresh when the success flag is present and the balance is still unpaid", () => {
    const decision = decideSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 0,
    });

    expect(decision).toEqual({ shouldSchedule: true, delayMs: SETTLEMENT_REFRESH_INTERVAL_MS });
  });

  it("stops once the retry cap has been reached", () => {
    const decision = decideSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: MAX_SETTLEMENT_REFRESH_ATTEMPTS,
    });

    expect(decision).toEqual({ shouldSchedule: false });
  });

  it("respects a custom interval/cap when provided", () => {
    const decision = decideSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 2,
      intervalMs: 500,
      maxAttempts: 3,
    });

    expect(decision).toEqual({ shouldSchedule: true, delayMs: 500 });

    const capped = decideSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 3,
      intervalMs: 500,
      maxAttempts: 3,
    });

    expect(capped).toEqual({ shouldSchedule: false });
  });
});

describe("scheduleSettlementRefresh", () => {
  it("never calls onRefresh when the success flag is absent -- no polling begins", () => {
    const onRefresh = vi.fn();
    scheduleSettlementRefresh({ success: undefined, isSettled: false, attemptsSoFar: 0, onRefresh });

    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * (MAX_SETTLEMENT_REFRESH_ATTEMPTS + 1));

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("never calls onRefresh for a cancelled/failed checkout query state", () => {
    const onRefresh = vi.fn();
    scheduleSettlementRefresh({ success: "checkout_cancelled", isSettled: false, attemptsSoFar: 0, onRefresh });

    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * (MAX_SETTLEMENT_REFRESH_ATTEMPTS + 1));

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("never calls onRefresh when the balance is already settled on arrival", () => {
    const onRefresh = vi.fn();
    scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: true,
      attemptsSoFar: 0,
      onRefresh,
    });

    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * (MAX_SETTLEMENT_REFRESH_ATTEMPTS + 1));

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("calls onRefresh exactly once after the bounded interval when the balance is still unpaid", () => {
    const onRefresh = vi.fn();
    scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 0,
      onRefresh,
    });

    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS - 1);
    expect(onRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("stops scheduling once a later call (simulating the next render) reports the balance settled", () => {
    const onRefresh = vi.fn();

    // Render 1: still unpaid -- schedules a refresh.
    const stopFirst = scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 0,
      onRefresh,
    });
    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    stopFirst();

    // Render 2 (after router.refresh() resolved with fresh data): settled now.
    scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: true,
      attemptsSoFar: 1,
      onRefresh,
    });
    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * (MAX_SETTLEMENT_REFRESH_ATTEMPTS + 1));

    // No second refresh was ever scheduled once settled.
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("stops once the retry cap is reached, even though the balance is still unpaid", () => {
    const onRefresh = vi.fn();

    scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: MAX_SETTLEMENT_REFRESH_ATTEMPTS,
      onRefresh,
    });

    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * 10);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("cleans up its timer when the returned stop function is called before it fires -- matches React unmount/dependency-change cleanup", () => {
    const onRefresh = vi.fn();
    const stop = scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 0,
      onRefresh,
    });

    stop();
    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS * 2);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("the returned stop function is always safe to call, even when nothing was scheduled", () => {
    const onRefresh = vi.fn();
    const stop = scheduleSettlementRefresh({
      success: undefined,
      isSettled: false,
      attemptsSoFar: 0,
      onRefresh,
    });

    expect(() => stop()).not.toThrow();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("never produces a false paid state -- the only observable side effect is the caller's own onRefresh callback, which the component wires to a real server re-read, not an independent success flag", () => {
    const onRefresh = vi.fn();
    scheduleSettlementRefresh({
      success: "balance_payment_submitted",
      isSettled: false,
      attemptsSoFar: 0,
      onRefresh,
    });

    vi.advanceTimersByTime(SETTLEMENT_REFRESH_INTERVAL_MS);

    // onRefresh was called with no arguments -- this module never passes a
    // "paid"/"settled" payload of its own; it only ever signals "go read
    // the server again."
    expect(onRefresh).toHaveBeenCalledWith();
    expect(onRefresh.mock.calls[0]).toHaveLength(0);
  });
});
