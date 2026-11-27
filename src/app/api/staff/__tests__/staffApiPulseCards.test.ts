import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, STUDIO_B, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  GET /pulse?include=cards: the opt-in command-center cards. The default response (no query) must stay byte-identical to v1; this file covers the
  card visibility by role and the failure isolation, with a fixed clock. The world fake has none of the card tables, so every table-backed card is "unavailable" here: the loaders are tested with real-shaped rows in src/lib/staff/__tests__/pulseCards.test.ts.
*/

const harness = vi.hoisted(() => ({ reads: [] as string[], failTable: null as string | null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const world = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {
      failures: harness.failTable ? { table: harness.failTable } : {},
    });
    const from = world.from.bind(world);
    world.from = ((table: string) => {
      harness.reads.push(table);
      return from(table);
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

function call(token: string | undefined, query = "", studioId = STUDIO_A) {
  return GET(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/pulse${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    { params: Promise.resolve({ studioId }) },
  );
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.reads = [];
  harness.failTable = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T15:30:00.000Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("default response is unchanged", () => {
  it.each([TOKENS.ownerA, TOKENS.frontDeskA, TOKENS.instructorA])("no query and unrelated queries add no cards and read no card table", async (token) => {
    const plain = await (await call(token)).json();
    expect(plain).not.toHaveProperty("cards");
    for (const query of ["?include=", "?include=other", "?include=Cards", "?cards=1"]) {
      harness.reads = [];
      const body = await (await call(token, query)).json();
      expect(body).toEqual(plain);
    }
    for (const table of ["booking_requests", "student_booking_action_requests", "lead_activities", "automation_actions", "client_packages"]) expect(harness.reads).not.toContain(table);
  });
});

describe("?include=cards", () => {
  it("adds cards next to the unchanged v1 fields", async () => {
    const plain = await (await call(TOKENS.ownerA)).json();
    const response = await call(TOKENS.ownerA, "?include=cards");
    expect(response.status).toBe(200);
    const { cards, ...rest } = await response.json();
    expect(rest).toEqual(plain);
    expect(Object.keys(cards).sort()).toEqual(["aria", "confirmations", "exceptions", "health", "leads", "requests"]);
    // health comes from the same day summary as `today`, so the numbers cannot disagree
    expect(cards.health).toMatchObject({ state: "ok", scope: "studio", sessionsToday: plain.today.total, sessionsAhead: plain.today.upcoming });
    // table-backed cards fail on this fake world and stay isolated
    expect(cards.requests).toEqual({ state: "unavailable" });
    expect(cards.aria).toEqual({ state: "unavailable" });
  });

  it("front desk has no ARIA card", async () => {
    const { cards } = await (await call(TOKENS.frontDeskA, "?include=cards")).json();
    expect(cards.aria).toBeNull();
    expect(cards.leads).not.toBeNull();
    expect(harness.reads).not.toContain("automation_actions");
  });

  it("an instructor gets own-scope health and exceptions, and no leads, ARIA, names or packages", async () => {
    const { cards, ...rest } = await (await call(TOKENS.instructorA, "?include=cards")).json();
    expect(cards.leads).toBeNull();
    expect(cards.aria).toBeNull();
    expect(cards.health).toMatchObject({ state: "ok", scope: "own", sessionsToday: rest.today.total });
    expect(cards.exceptions).toMatchObject({ state: "ok", cancelledToday: rest.today.cancelled, lowPackages: null });
    expect(harness.reads).not.toContain("client_packages");
    expect(harness.reads).not.toContain("automation_actions");
    expect(harness.reads).not.toContain("lead_activities");
  });

  it("an independent instructor is still refused before any card read", async () => {
    const response = await call(TOKENS.independentA, "?include=cards");
    expect(response.status).toBe(403);
    expect(harness.reads).not.toContain("booking_requests");
  });

  it("another studio's owner is refused before any read", async () => {
    const response = await call(TOKENS.ownerA, "?include=cards", STUDIO_B);
    expect(response.status).toBe(403);
    expect(harness.reads).not.toContain("booking_requests");
  });

  it("no token is a 401", async () => {
    expect((await call(undefined, "?include=cards")).status).toBe(401);
  });

  it("a failure of the day summary is still a flat 503, with or without cards", async () => {
    harness.failTable = "appointments";
    const response = await call(TOKENS.ownerA, "?include=cards");
    expect(response.status).toBe(503);
    expect(Object.keys(await response.json()).sort()).toEqual(["code", "error"]);
  });
});
