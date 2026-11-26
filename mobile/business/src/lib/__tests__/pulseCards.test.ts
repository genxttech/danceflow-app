import { createStaffApi, toStaffPulse } from "@/lib/staffApi";
import { needsYouItems, toPulseCards, waitingLabel, type PulseCards } from "@/lib/pulseCards";

const OK_CARDS = {
  requests: {
    state: "ok",
    bookingRequests: 2,
    selfService: 1,
    total: 3,
    oldestCreatedAt: "2026-11-20T10:00:00.000Z",
    truncated: false,
    recent: [{ id: "r1", source: "self_service", kind: "reschedule", createdAt: "2026-11-22T09:00:00.000Z", requestedStartsAt: null, clientName: "Maya Chen" }],
  },
  leads: {
    state: "ok",
    newLast7Days: 2,
    uncontacted: 1,
    followUpsOverdue: 1,
    truncated: false,
    recent: [{ id: "l1", name: "Lena Lead", createdAt: "2026-11-21T10:00:00.000Z", sourceLabel: "Intro booking", uncontacted: true, followUpDueAt: null }],
  },
  aria: { state: "ok", open: 2, truncated: false, recent: [{ id: "x1", title: "Reach out", priority: "high", createdAt: "2026-11-21T00:00:00.000Z", ruleKey: "lapsed_client", status: "suggested" }] },
  exceptions: { state: "ok", cancelledToday: 1, lowPackages: 3, truncated: false },
  health: { state: "ok", scope: "studio", sessionsToday: 6, sessionsDone: 4, sessionsAhead: 2, truncated: false },
};

describe("toPulseCards", () => {
  it("reads every ok card", () => {
    const cards = toPulseCards(OK_CARDS) as PulseCards;
    expect(cards.requests).toMatchObject({ state: "ok", total: 3, recent: [{ id: "r1", kind: "reschedule", clientName: "Maya Chen" }] });
    expect(cards.leads).toMatchObject({ newLast7Days: 2, uncontacted: 1, followUpsOverdue: 1 });
    expect(cards.aria).toMatchObject({ open: 2, recent: [{ title: "Reach out", priority: "high" }] });
    expect(cards.exceptions).toMatchObject({ cancelledToday: 1, lowPackages: 3 });
    expect(cards.health).toMatchObject({ scope: "studio", sessionsToday: 6 });
  });

  it("null or absent is hidden, never an error", () => {
    expect(toPulseCards({ requests: null, leads: undefined, aria: null, exceptions: null, health: null })).toEqual({
      requests: null,
      leads: null,
      aria: null,
      exceptions: null,
      health: null,
      confirmations: null, // a server that predates the card
    });
    expect(toPulseCards(null)).toBeNull();
    expect(toPulseCards("nope")).toBeNull();
  });

  it("unavailable and unreadable shapes become that card's unavailable state only", () => {
    const cards = toPulseCards({ ...OK_CARDS, aria: { state: "unavailable" }, leads: "garbage", requests: { state: "weird" }, exceptions: [] }) as PulseCards;
    expect(cards.aria).toEqual({ state: "unavailable" });
    expect(cards.leads).toEqual({ state: "unavailable" });
    expect(cards.requests).toEqual({ state: "unavailable" });
    expect(cards.exceptions).toEqual({ state: "unavailable" });
    expect(cards.health).toMatchObject({ state: "ok" });
  });

  it("clamps bad numbers to 0 and drops list items without an id or time", () => {
    const cards = toPulseCards({
      ...OK_CARDS,
      leads: { state: "ok", newLast7Days: -4, uncontacted: "7", followUpsOverdue: NaN, recent: [{ id: "", createdAt: "x" }, { id: "l9", createdAt: "2026-11-21T00:00:00Z" }, null] },
    }) as PulseCards;
    expect(cards.leads).toMatchObject({ newLast7Days: 0, uncontacted: 0, followUpsOverdue: 0 });
    expect((cards.leads as { recent: unknown[] }).recent).toEqual([expect.objectContaining({ id: "l9", name: "Unnamed lead", sourceLabel: "Studio" })]);
  });

  it("an instructor's lowPackages stays null, not 0", () => {
    const cards = toPulseCards({ ...OK_CARDS, exceptions: { state: "ok", cancelledToday: 2, lowPackages: null } }) as PulseCards;
    expect(cards.exceptions).toMatchObject({ lowPackages: null });
  });
});

describe("needsYouItems", () => {
  it("lists requests, overdue and uncontacted leads separately, and ARIA", () => {
    const items = needsYouItems(toPulseCards(OK_CARDS) as PulseCards);
    expect(items.map((i) => [i.key, i.count])).toEqual([
      ["requests", 3],
      ["leadsOverdue", 1],
      ["leadsUncontacted", 1],
      ["aria", 2],
    ]);
    expect(items[1].label).toBe("lead follow-up overdue");
  });

  it("is empty when nothing waits, and ignores hidden or unavailable cards", () => {
    const cards = toPulseCards({ ...OK_CARDS, requests: { state: "ok", total: 0 }, leads: { state: "ok" }, aria: { state: "unavailable" } }) as PulseCards;
    expect(needsYouItems(cards)).toEqual([]);
    expect(needsYouItems({ requests: null, leads: null, aria: null, exceptions: null, health: null, confirmations: null })).toEqual([]);
  });

  it("lists unconfirmed appointments after requests, in the singular for one, and never for zero", () => {
    const one = toPulseCards({ ...OK_CARDS, confirmations: { state: "ok", windowHours: 48, total: 1, upcoming: [] } }) as PulseCards;
    expect(needsYouItems(one).map((item) => item.key)).toEqual(["requests", "confirmations", "leadsOverdue", "leadsUncontacted", "aria"]);
    expect(needsYouItems(one)[1].label).toBe("appointment not confirmed in the next 48 hours");
    const none = toPulseCards({ ...OK_CARDS, confirmations: { state: "ok", windowHours: 48, total: 0, upcoming: [] } }) as PulseCards;
    expect(needsYouItems(none).some((item) => item.key === "confirmations")).toBe(false);
  });

  it("drops a confirmation row without an id or a readable time, and keeps the server's total", () => {
    const cards = toPulseCards({
      ...OK_CARDS,
      confirmations: { state: "ok", total: 3, upcoming: [{ id: "a", startsAt: "2026-11-23T15:00:00Z" }, { startsAt: "2026-11-23T15:00:00Z" }, { id: "b", startsAt: "soon" }] },
    }) as PulseCards;
    expect(cards.confirmations).toEqual({ state: "ok", windowHours: 48, total: 3, truncated: false, upcoming: [{ id: "a", startsAt: "2026-11-23T15:00:00Z", appointmentType: "appointment", clientName: null }] });
  });
});

describe("waitingLabel", () => {
  const now = new Date("2026-11-22T12:00:00.000Z");
  it.each([
    ["2026-11-22T12:00:00.000Z", "just now"],
    ["2026-11-22T11:30:00.000Z", "under an hour"],
    ["2026-11-22T11:00:00.000Z", "1 hour"],
    ["2026-11-22T07:00:00.000Z", "5 hours"],
    ["2026-11-21T11:00:00.000Z", "1 day"],
    ["2026-11-19T12:00:00.000Z", "3 days"],
    ["2026-11-23T12:00:00.000Z", "just now"],
    ["not a date", "just now"],
  ])("%s is %s", (iso, label) => expect(waitingLabel(iso, now)).toBe(label));
});

describe("the API adapter", () => {
  const base = {
    studioId: "s1",
    timeZone: "UTC",
    date: "2026-11-22",
    asOf: "2026-11-22T12:00:00.000Z",
    scope: "studio",
    instructorId: null,
    today: { total: 1, upcoming: 1, cancelled: 0, truncated: false },
    next: null,
    newClientsLast7Days: 1,
  };
  const build = (body: unknown) => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
    const api = createStaffApi({ baseUrl: "https://danceflow.test", getAccessToken: async () => "t", refreshAccessToken: async () => null, fetchImpl: fetchImpl as unknown as typeof fetch });
    return { api, fetchImpl };
  };

  it("asks for the cards only when told to, and the default URL is the v1 URL", async () => {
    const plain = build(base);
    await plain.api.pulse("s1");
    expect((plain.fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://danceflow.test/api/staff/workspaces/s1/pulse");
    const withCards = build({ ...base, cards: OK_CARDS });
    const result = await withCards.api.pulse("s1", { cards: true });
    expect((withCards.fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://danceflow.test/api/staff/workspaces/s1/pulse?include=cards");
    expect(result.cards?.requests).toMatchObject({ state: "ok", total: 3 });
  });

  it("a v1 server's response has no cards key, so the v1 shape is unchanged", () => {
    expect(toStaffPulse(base)).not.toHaveProperty("cards");
    expect(toStaffPulse({ ...base, cards: null }).cards).toBeNull();
  });
});
