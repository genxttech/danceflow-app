import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeQuery, STUDIO_A, STUDIO_B, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  GET /pulse?include=cards through the REAL route handler with populated card tables (the sibling file staffApiPulseCards.test.ts only has the cards in their
  "unavailable" state, because the shared world has none of the card tables). Fixed clock, in-memory rows: visibility by role, tenancy, classification and the
  default body staying byte-identical when cards are on.
*/

type Row = Record<string, unknown>;

const NOW = "2026-11-09T15:30:00.000Z";
const A = STUDIO_A;
const B = STUDIO_B;

const extra: Record<string, Row[]> = {
  booking_requests: [
    { id: "br-a1", studio_id: A, client_id: "cli-a1", instructor_id: "ins-a1", status: "pending", created_at: "2026-11-07T10:00:00Z", requested_starts_at: "2026-11-12T15:00:00Z", customer_first_name: null, customer_last_name: null },
    { id: "br-a2", studio_id: A, client_id: null, instructor_id: "ins-a2", status: "pending", created_at: "2026-11-08T10:00:00Z", requested_starts_at: null, customer_first_name: "Pat", customer_last_name: "Walker" },
    { id: "br-a3", studio_id: A, client_id: "cli-a1", instructor_id: "ins-a1", status: "approved", created_at: "2026-11-01T10:00:00Z", requested_starts_at: null },
    { id: "br-b1", studio_id: B, client_id: "cli-b1", instructor_id: null, status: "pending", created_at: "2026-11-06T10:00:00Z", requested_starts_at: null },
  ],
  student_booking_action_requests: [
    { id: "sr-a1", studio_id: A, client_id: "cli-a3", instructor_id: "ins-a1", action_type: "reschedule", status: "pending", booking_request_id: null, created_at: "2026-11-09T09:00:00Z", requested_starts_at: "2026-11-13T15:00:00Z" },
    { id: "sr-a2", studio_id: A, client_id: "cli-a3", instructor_id: "ins-a1", action_type: "book", status: "pending", booking_request_id: "br-a1", created_at: "2026-11-09T09:30:00Z", requested_starts_at: "2026-11-14T15:00:00Z" },
    { id: "sr-a3", studio_id: A, client_id: "cli-a3", instructor_id: "ins-a1", action_type: "cancel", status: "executed", booking_request_id: null, created_at: "2026-11-02T09:00:00Z", requested_starts_at: null },
  ],
  // the world's clients plus lead rows: status, source and source_system are what the leads card reads
  clients: [
    { id: "cli-a1", studio_id: A, first_name: "Ana", last_name: "Own", status: "active", referral_source: "secret-referral", source_system: null, is_independent_instructor: false, created_at: "2026-11-05T00:00:00Z" },
    { id: "cli-a3", studio_id: A, first_name: "Pat", last_name: "Partner", status: "active", referral_source: null, source_system: null, is_independent_instructor: false, created_at: "2026-11-08T12:00:00Z" },
    { id: "cli-b1", studio_id: B, first_name: "Bea", last_name: "Bstudio", status: "active", referral_source: null, source_system: null, is_independent_instructor: false, created_at: "2026-11-08T12:00:00Z" },
    { id: "L-web", studio_id: A, first_name: "Priya", last_name: "Nair", status: "lead", referral_source: "website", source_system: null, is_independent_instructor: false, created_at: "2026-11-08T10:00:00Z" },
    { id: "L-event", studio_id: A, first_name: "Eva", last_name: "Eventgoer", status: "lead", referral_source: "Event Registration", source_system: "event_registration", is_independent_instructor: false, created_at: "2026-11-09T10:00:00Z" },
    { id: "L-lookalike", studio_id: A, first_name: "Ellis", last_name: "Marlowe", status: "lead", referral_source: "Eventbrite Registration", source_system: null, is_independent_instructor: false, created_at: "2026-11-09T11:00:00Z" },
    { id: "L-b", studio_id: B, first_name: "Zara", last_name: "Otherstudio", status: "lead", referral_source: "website", source_system: null, is_independent_instructor: false, created_at: "2026-11-09T11:00:00Z" },
  ],
  lead_activities: [{ id: "la1", studio_id: A, client_id: "L-web", follow_up_due_at: "2026-11-08T10:00:00Z", completed_at: null }],
  automation_actions: [
    { id: "x-a1", studio_id: A, rule_key: "lapsed_client", title: "Reach out to Ana", status: "suggested", priority: "high", created_at: "2026-11-08T00:00:00Z" },
    { id: "x-a2", studio_id: A, rule_key: "birthday", title: "Approved already", status: "approved", priority: "low", created_at: "2026-11-07T00:00:00Z" },
    { id: "x-b1", studio_id: B, rule_key: "lapsed_client", title: "Other studio suggestion", status: "suggested", priority: "high", created_at: "2026-11-08T00:00:00Z" },
  ],
  // the confirmations card reads appointments: the clock is 2026-11-09T15:30Z, so the 48-hour window ends 2026-11-11T15:30Z
  appointments: [
    { id: "ap-own", studio_id: A, client_id: "cli-a1", instructor_id: "ins-a1", appointment_type: "private_lesson", title: null, status: "scheduled", starts_at: "2026-11-10T15:00:00Z", ends_at: "2026-11-10T15:45:00Z" },
    { id: "ap-colleague", studio_id: A, client_id: "cli-a3", instructor_id: "ins-a2", appointment_type: "private_lesson", title: null, status: "rescheduled", starts_at: "2026-11-11T15:30:00.000Z", ends_at: "2026-11-11T16:15:00Z" },
    { id: "ap-confirmed", studio_id: A, client_id: "cli-a1", instructor_id: "ins-a1", appointment_type: "private_lesson", title: null, status: "confirmed", starts_at: "2026-11-10T16:00:00Z", ends_at: "2026-11-10T16:45:00Z" },
    { id: "ap-later", studio_id: A, client_id: "cli-a1", instructor_id: "ins-a1", appointment_type: "private_lesson", title: null, status: "scheduled", starts_at: "2026-11-12T15:00:00Z", ends_at: "2026-11-12T15:45:00Z" },
    { id: "ap-b", studio_id: B, client_id: "cli-b1", instructor_id: null, appointment_type: "private_lesson", title: null, status: "scheduled", starts_at: "2026-11-10T15:00:00Z", ends_at: "2026-11-10T15:45:00Z" },
  ],
  client_packages: [
    { id: "p-a1", studio_id: A, active: true, client_package_items: [{ quantity_remaining: 1, is_unlimited: false }] },
    { id: "p-b1", studio_id: B, active: true, client_package_items: [{ quantity_remaining: 0, is_unlimited: false }] },
  ],
};

const harness = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const world = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""));
    const from = world.from.bind(world);
    world.from = ((table: string) => {
      harness.reads.push(table);
      return table in extra ? new FakeQuery(extra[table], null) : from(table);
    }) as typeof world.from;
    return world;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminWorldClient() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    throw new Error("The staff API must never build a cookie client");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("The staff API must never read cookies");
  },
  headers: async () => new Headers(),
}));

const { GET } = await import("../workspaces/[studioId]/pulse/route");

function call(token: string, query = "?include=cards", studioId = STUDIO_A) {
  return GET(new Request(`https://app.test/api/staff/workspaces/${studioId}/pulse${query}`, { headers: { Authorization: `Bearer ${token}` } }), { params: Promise.resolve({ studioId }) });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.reads = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Cards = Record<string, Record<string, unknown> | null>;
const cardsFor = async (token: string) => ((await (await call(token)).json()) as { cards: Cards }).cards;

describe("populated cards through the real route", () => {
  it("owner: every card is ok with the right numbers, and the v1 fields are unchanged", async () => {
    const plain = await (await call(TOKENS.ownerA, "")).json();
    const { cards, ...rest } = await (await call(TOKENS.ownerA)).json();
    expect(rest).toEqual(plain);
    expect(cards.requests).toMatchObject({ state: "ok", bookingRequests: 2, selfService: 1, total: 3 }); // sr-a2 is linked to br-a1: not counted twice; br-a3 approved and sr-a3 executed are not open
    expect(cards.leads).toMatchObject({ state: "ok", newLast7Days: 2, uncontacted: 1, followUpsOverdue: 1 });
    expect(cards.aria).toMatchObject({ state: "ok", open: 1 });
    expect(cards.exceptions).toMatchObject({ state: "ok", lowPackages: 1 });
    expect(cards.health).toMatchObject({ state: "ok", scope: "studio" });
    for (const card of Object.values(cards)) expect(card).toMatchObject({ actions: [] });
  });

  it("classification: the event registrant is not a lead, a look-alike source still is, other studios never appear", async () => {
    const cards = await cardsFor(TOKENS.ownerA);
    const names = ((cards.leads as { recent: { name: string }[] }).recent).map((lead) => lead.name);
    expect(names).toEqual(expect.arrayContaining(["Priya Nair", "Ellis Marlowe"]));
    expect(names).not.toContain("Eva Eventgoer");
    const text = JSON.stringify(cards);
    expect(text).not.toMatch(/Zara|Otherstudio|Other studio suggestion|br-b1|p-b1/);
    const requestIds = ((cards.requests as { recent: { id: string }[] }).recent).map((item) => item.id);
    expect(requestIds).not.toContain("br-a3");
    expect(requestIds).not.toContain("sr-a3");
    expect(requestIds).not.toContain("sr-a2");
  });

  it("owner sees names on requests, including the typed name of a public request", async () => {
    const cards = await cardsFor(TOKENS.ownerA);
    const names = ((cards.requests as { recent: { clientName: string | null }[] }).recent).map((item) => item.clientName);
    expect(names).toEqual(expect.arrayContaining(["Pat Walker", "Ana Own", "Pat Partner"]));
  });

  it("front desk: same request and lead numbers as the owner, no ARIA and no read of the ARIA table", async () => {
    const owner = await cardsFor(TOKENS.ownerA);
    harness.reads = [];
    const frontDesk = await cardsFor(TOKENS.frontDeskA);
    expect(frontDesk.aria).toBeNull();
    expect(harness.reads).not.toContain("automation_actions");
    expect(frontDesk.requests).toMatchObject({ total: (owner.requests as { total: number }).total });
    expect(frontDesk.leads).toMatchObject({ uncontacted: (owner.leads as { uncontacted: number }).uncontacted });
  });

  it("instructor: only their own requests, no names, no leads, ARIA or packages, and none of those tables is read", async () => {
    const cards = await cardsFor(TOKENS.instructorA);
    expect(cards.leads).toBeNull();
    expect(cards.aria).toBeNull();
    expect(cards.requests).toMatchObject({ state: "ok", total: 2, bookingRequests: 1, selfService: 1 }); // br-a1 and sr-a1; br-a2 belongs to the colleague; sr-a2 is linked
    expect(((cards.requests as { recent: { clientName: string | null }[] }).recent).every((item) => item.clientName === null)).toBe(true);
    expect(cards.exceptions).toMatchObject({ state: "ok", lowPackages: null });
    for (const table of ["lead_activities", "automation_actions", "client_packages"]) expect(harness.reads).not.toContain(table);
    expect(JSON.stringify(cards)).not.toMatch(/Priya|Pat Walker|Ana Own|Pat Partner/);
  });

  it("an unlinked instructor gets zero requests, never the studio's", async () => {
    const cards = await cardsFor(TOKENS.unlinkedInstructorA);
    expect(cards.requests).toMatchObject({ state: "ok", total: 0, recent: [] });
  });

  it("confirmations: the owner and front desk see the studio's 48-hour list with names; the instructor only their own, without names", async () => {
    for (const token of [TOKENS.ownerA, TOKENS.frontDeskA]) {
      const cards = await cardsFor(token);
      expect(cards.confirmations).toMatchObject({ state: "ok", cardId: "missing_confirmations", windowHours: 48, total: 2, actions: [] });
      expect((cards.confirmations as { upcoming: { id: string; clientName: string }[] }).upcoming.map((item) => [item.id, item.clientName])).toEqual([
        ["ap-own", "Ana Own"],
        ["ap-colleague", "Pat Partner"],
      ]);
    }
    const own = await cardsFor(TOKENS.instructorA);
    expect(own.confirmations).toMatchObject({ state: "ok", total: 1, upcoming: [{ id: "ap-own", clientName: null }] });
    expect(await cardsFor(TOKENS.unlinkedInstructorA).then((cards) => cards.confirmations)).toMatchObject({ total: 0, upcoming: [] });
  });

  it("another studio's owner is refused before any card read", async () => {
    const response = await call(TOKENS.ownerA, "?include=cards", STUDIO_B);
    expect(response.status).toBe(403);
    expect(harness.reads).not.toContain("booking_requests");
  });
});
