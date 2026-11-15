import { createStaffApi, StaffApiError, toStaffPulse } from "@/lib/staffApi";
import { parseStaffFeatures } from "@/lib/features";
import { tabsForWorkspace } from "@/lib/navigation";
import type { StaffWorkspace } from "@/lib/staffApi";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const STUDIO_PULSE = {
  studioId: "s1",
  timeZone: "America/New_York",
  date: "2026-11-09",
  asOf: "2026-11-09T15:30:00.000Z",
  scope: "studio",
  instructorId: null,
  today: { total: 5, upcoming: 4, cancelled: 1, truncated: false },
  next: { id: "a1", appointmentType: "private_lesson", title: null, status: "scheduled", startsAt: "2026-11-09T16:00:00.000Z", endsAt: "2026-11-09T16:45:00.000Z" },
  newClientsLast7Days: 3,
};

describe("pulse adapter", () => {
  it("requests GET /pulse with the bearer token, the studio id encoded", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, STUDIO_PULSE));
    const api = createStaffApi({
      baseUrl: "https://danceflow.test/",
      getAccessToken: async () => "token-1",
      refreshAccessToken: async () => null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await api.pulse("studio 1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://danceflow.test/api/staff/workspaces/studio%201/pulse");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer token-1");
    expect(result).toEqual(STUDIO_PULSE);
  });

  it("surfaces the flat error as a StaffApiError the screens already know how to explain", async () => {
    const api = createStaffApi({
      baseUrl: "https://danceflow.test",
      getAccessToken: async () => "token-1",
      refreshAccessToken: async () => null,
      fetchImpl: (async () => jsonResponse(403, { error: "Your role cannot view the studio summary.", code: "role_not_permitted" })) as unknown as typeof fetch,
    });
    await expect(api.pulse("s1")).rejects.toMatchObject({ status: 403, code: "role_not_permitted" });
    await expect(api.pulse("s1")).rejects.toBeInstanceOf(StaffApiError);
  });
});

describe("toStaffPulse", () => {
  it("normalises a malformed body: counts are never NaN, an unknown scope is the narrower one, no client count for it", () => {
    const pulse = toStaffPulse({ scope: "everyone", today: { total: "5", upcoming: -2, cancelled: NaN }, newClientsLast7Days: 9, next: { id: "a" } });
    expect(pulse.scope).toBe("own");
    expect(pulse.today).toEqual({ total: 0, upcoming: 0, cancelled: 0, truncated: false });
    expect(pulse.newClientsLast7Days).toBeNull();
    expect(pulse.next).toBeNull(); // a next without a start time is dropped, not half-shown
  });

  it("keeps a well-formed next and a studio client count", () => {
    const pulse = toStaffPulse(STUDIO_PULSE);
    expect(pulse.next?.id).toBe("a1");
    expect(pulse.newClientsLast7Days).toBe(3);
  });

  it("an empty body is a safe empty pulse", () => {
    expect(toStaffPulse(null)).toMatchObject({ scope: "own", instructorId: null, next: null, newClientsLast7Days: null });
  });
});

describe("pulse flag and tab", () => {
  const owner = (overrides: Partial<StaffWorkspace> = {}): StaffWorkspace => ({
    studioId: "s1",
    name: "Studio",
    publicName: null,
    slug: null,
    role: "instructor",
    accessAllowed: true,
    subscriptionStatus: "active",
    capabilities: { viewStudioSchedule: true, viewClients: false, viewReports: false },
    ...overrides,
  });

  it("is off by default and named per build; none turns everything off", () => {
    expect(parseStaffFeatures(undefined).has("pulse")).toBe(false);
    expect(parseStaffFeatures(undefined).has("studioSchedule")).toBe(false);
    expect(parseStaffFeatures("pulse").has("pulse")).toBe(true);
    expect(parseStaffFeatures("pulse,studioSchedule").has("studioSchedule")).toBe(true);
    expect(parseStaffFeatures("pulse,-pulse").has("pulse")).toBe(false);
    expect(parseStaffFeatures("none").size).toBe(0);
  });

  it("an instructor gets the Pulse tab only when it is enabled; an owner keeps it either way", () => {
    expect(tabsForWorkspace(owner())).toEqual(["today", "clients", "more"]);
    expect(tabsForWorkspace(owner(), { pulseForAll: true })).toEqual(["pulse", "today", "clients", "more"]);
    const ownerWorkspace = owner({ role: "studio_owner", capabilities: { viewStudioSchedule: true, viewClients: true, viewReports: true } });
    expect(tabsForWorkspace(ownerWorkspace)).toContain("pulse");
  });

  it("the flag never gives a tab to a role the app does not serve or to a paused studio", () => {
    expect(tabsForWorkspace(owner({ role: "independent_instructor" }), { pulseForAll: true })).toEqual(["more"]);
    expect(tabsForWorkspace(owner({ accessAllowed: false }), { pulseForAll: true })).toEqual(["more"]);
  });
});
