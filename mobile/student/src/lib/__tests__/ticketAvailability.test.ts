// "N spots left" / "Sold out" come from the web API (server-side count), never from counting the dancer's own registrations.
const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) }, from: jest.fn() } }));
jest.mock("@/lib/danceflowApi", () => ({ danceflowApiFetch: (...a: unknown[]) => mockFetch(...a) }));

import { loadTicketAvailability } from "@/lib/publicDiscovery";

const EVENT = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { user: { id: "u1" } } } });
});

describe("loadTicketAvailability", () => {
  it("asks the availability route for the event and maps remaining, sold out and unlimited tickets", async () => {
    mockFetch.mockResolvedValueOnce({
      eventId: EVENT,
      tickets: [
        { ticketTypeId: T1, capacity: 50, remaining: 12, soldOut: false },
        { ticketTypeId: T2, capacity: 10, remaining: 0, soldOut: true },
        { ticketTypeId: T3, capacity: null, remaining: null, soldOut: false },
      ],
    });
    const result = await loadTicketAvailability(EVENT);
    expect(mockFetch).toHaveBeenCalledWith(`/api/student/events/${EVENT}/availability`);
    expect(result).toEqual(new Map([[T1, 12], [T2, 0], [T3, null]]));
  });

  it("signed out: no request and no count", async () => {
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });
    expect(await loadTicketAvailability(EVENT)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["404 not available", Object.assign(new Error("This event is not available."), { status: 404 })],
    ["429 rate limited", new Error("Too many requests")],
    ["500", new Error("Availability could not be loaded.")],
    ["offline", new TypeError("Network request failed")],
  ])("%s gives no count (never a wrong 'N left')", async (_name, error) => {
    mockFetch.mockRejectedValueOnce(error);
    expect(await loadTicketAvailability(EVENT)).toBeNull();
  });

  it.each([
    ["no tickets array", { eventId: EVENT }],
    ["a ticket without an id", { eventId: EVENT, tickets: [{ remaining: 3 }] }],
    ["a non-object body", "ok"],
  ])("a malformed answer (%s) gives no count", async (_name, body) => {
    mockFetch.mockResolvedValueOnce(body);
    expect(await loadTicketAvailability(EVENT)).toBeNull();
  });

  it("clamps a negative remaining to 0 and ignores a non-numeric one as unlimited-unknown", async () => {
    mockFetch.mockResolvedValueOnce({ eventId: EVENT, tickets: [{ ticketTypeId: T1, remaining: -2, soldOut: false }, { ticketTypeId: T2, remaining: "7", soldOut: false }] });
    expect(await loadTicketAvailability(EVENT)).toEqual(new Map([[T1, 0], [T2, null]]));
  });
});

describe("source guard", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  it("publicDiscovery no longer reads event_registrations", () => {
    const src = readFileSync(join(__dirname, "..", "publicDiscovery.ts"), "utf8");
    expect(src).not.toMatch(/from\("event_registrations"\)/);
  });
});
