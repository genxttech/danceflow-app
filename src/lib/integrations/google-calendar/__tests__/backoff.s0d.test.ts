import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { deleteGoogleCalendarEvent, googleBackoffDelayMs, listGoogleCalendars } from "../client";

const original = globalThis.fetch;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); globalThis.fetch = original; });

const rate403 = () => new Response(JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }), { status: 403 });

describe("S0-d google backoff", () => {
  it("computes capped exponential or Retry-After delays", () => {
    expect(googleBackoffDelayMs(0, null)).toBe(1000);
    expect(googleBackoffDelayMs(1, null)).toBe(2000);
    expect(googleBackoffDelayMs(5, null)).toBe(5000);
    expect(googleBackoffDelayMs(0, "3")).toBe(3000);
    expect(googleBackoffDelayMs(0, "999")).toBe(5000);
  });

  it("retries 429 and rate-limit 403, then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(rate403())
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "c", summary: "S", accessRole: "owner" }] }), { status: 200 }));
    globalThis.fetch = fetchMock as any;
    const promise = listGoogleCalendars("tok");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await promise).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after two retries and surfaces the error", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }));
    globalThis.fetch = fetchMock as any;
    const promise = listGoogleCalendars("tok");
    const assertion = expect(promise).rejects.toThrow("slow down");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry other 403s or 5xx, and DELETE also backs off", async () => {
    const forbidden = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "no", errors: [{ reason: "forbidden" }] } }), { status: 403 }));
    globalThis.fetch = forbidden as any;
    await expect(listGoogleCalendars("tok")).rejects.toThrow("no");
    expect(forbidden).toHaveBeenCalledTimes(1);

    const del = vi.fn().mockResolvedValueOnce(rate403()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = del as any;
    const promise = deleteGoogleCalendarEvent({ accessToken: "t", calendarId: "c", eventId: "e" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await promise).toEqual({ deleted: true, missing: false });
    expect(del).toHaveBeenCalledTimes(2);
  });
});
