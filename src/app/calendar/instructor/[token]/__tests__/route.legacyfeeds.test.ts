/* eslint-disable @typescript-eslint/no-explicit-any -- mocks */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tryHandle = vi.fn<(...args: any[]) => Promise<Response | null>>();
vi.mock("@/lib/calendar-feeds/handler", () => ({ tryHandleFeedRequest: (...args: any[]) => tryHandle(...args) }));

let adminThrows = false;
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    if (adminThrows) throw new Error("no admin");
    const b: any = {
      select: () => b,
      update: () => b,
      eq: () => b,
      single: () => Promise.resolve({ data: null, error: { message: "none" } }),
      then: (r: any) => r({ data: [], error: null }),
    };
    return { from: () => b };
  },
}));

import { GET } from "../route";

const env = { ...process.env };
const call = (token = "tok.ics") => GET(new Request("http://x/calendar/instructor/" + token, { headers: { "x-forwarded-for": "203.0.113.1" } }), { params: Promise.resolve({ token }) });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  tryHandle.mockReset();
  adminThrows = false;
});
afterEach(() => {
  process.env = { ...env };
});

describe("legacy instructor feed route: migrated-token path", () => {
  it("flag off: the new path is never consulted and the legacy response is unchanged", async () => {
    delete process.env.CALENDAR_FEEDS_ENABLED;
    const res = await call();
    expect(tryHandle).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Calendar feed not found.");
  });

  it("flag on and the token is owned by the new feeds: the new response is returned as is", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    tryHandle.mockResolvedValue(new Response("BEGIN:VCALENDAR", { status: 200 }));
    const res = await call("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG.ics");
    expect(res.status).toBe(200);
    expect(tryHandle.mock.calls[0][1]).toBe("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"); // .ics suffix removed before lookup
  });

  it("flag on but the new feeds do not own the token (or the studio is disabled): falls through to the legacy response", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    tryHandle.mockResolvedValue(null);
    const res = await call();
    expect(tryHandle).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Calendar feed not found.");
  });

  it("flag on and the new path throws: falls through to legacy instead of failing the subscriber", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    tryHandle.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Calendar feed not found.");
  });

  it("a rate-limit refusal from the new path (owned token over its limit) is returned, not swallowed", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    tryHandle.mockResolvedValue(new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } }));
    const res = await call();
    expect(res.status).toBe(429);
  });

  it("an empty token is still a 400 and never reaches the new path", async () => {
    process.env.CALENDAR_FEEDS_ENABLED = "true";
    const res = await call(".ics");
    expect(res.status).toBe(400);
    expect(tryHandle).not.toHaveBeenCalled();
  });
});
