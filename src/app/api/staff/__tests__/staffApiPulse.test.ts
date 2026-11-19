import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, STUDIO_B, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  GET /api/staff/workspaces/{studioId}/pulse: counts and the next appointment. Refusals before any read are in staffApiSlice2Refusals.test.ts; this file covers the
  role scoping and the numbers, with a fixed clock (2026-11-09 15:30Z = 10:30 in New York).
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

function call(token: string | undefined, studioId = STUDIO_A) {
  return GET(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/pulse`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
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

describe("studio scope (owner, front desk)", () => {
  it.each([
    ["owner", TOKENS.ownerA],
    ["front desk", TOKENS.frontDeskA],
  ])("%s sees the studio's day, the next appointment and the new-client count", async (_role, token) => {
    const response = await call(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      studioId: STUDIO_A,
      timeZone: "America/New_York",
      date: "2026-11-09",
      asOf: "2026-11-09T15:30:00.000Z",
      scope: "studio",
      instructorId: null,
      // five live rows today (own lesson 15:00Z, colleague lesson, colleague class, rental, the 23:59 class) and one cancelled
      today: { total: 5, upcoming: 4, cancelled: 1, truncated: false },
      next: {
        id: "a0000000-0000-4000-8000-000000000003",
        appointmentType: "private_lesson",
        title: null,
        status: "scheduled",
        startsAt: "2026-11-09T16:00:00.000Z",
        endsAt: null,
      },
      // created in the last 7 days at studio A: Ana, Pat, Rene (Colin is older; Bea is studio B)
      newClientsLast7Days: 3,
    });
  });

  it("names no person and carries no money or contact", async () => {
    const text = JSON.stringify(await (await call(TOKENS.ownerA)).json());
    for (const word of ["price", "payment", "billing", "phone", "referral", "Ana", "Colin", "Pat", "Rene", "first", "last"]) expect(text).not.toContain(word);
  });
});

describe("own scope (instructors)", () => {
  it("an instructor sees only their own day and no client count", async () => {
    const body = await (await call(TOKENS.instructorA)).json();
    expect(body).toMatchObject({
      scope: "own",
      instructorId: "ins-a1",
      today: { total: 2, upcoming: 1, cancelled: 1, truncated: false },
      newClientsLast7Days: null,
    });
    expect(body.next.id).toBe("a0000000-0000-4000-8000-000000000002"); // the 23:59 class
    expect(harness.reads).not.toContain("clients");
  });

  it("a colleague's numbers are the colleague's, not the studio's", async () => {
    const body = await (await call(TOKENS.colleagueA)).json();
    expect(body.today).toMatchObject({ total: 2, upcoming: 2, cancelled: 0 });
    expect(body.next.id).toBe("a0000000-0000-4000-8000-000000000003");
  });

  it("an instructor with no instructor record gets an empty day, never the studio's", async () => {
    const body = await (await call(TOKENS.unlinkedInstructorA)).json();
    expect(body).toMatchObject({ scope: "own", instructorId: null, today: { total: 0, upcoming: 0, cancelled: 0 }, next: null, newClientsLast7Days: null });
    expect(harness.reads).not.toContain("appointments");
    expect(harness.reads).not.toContain("clients");
  });
});

describe("refusals and failures", () => {
  it("another studio's owner is refused before any read", async () => {
    const response = await call(TOKENS.ownerA, STUDIO_B);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_a_member" });
    expect(harness.reads).not.toContain("appointments");
  });

  it("a read failure is a flat 503", async () => {
    harness.failTable = "appointments";
    const response = await call(TOKENS.ownerA);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    expect(body.code).toBe("service_unavailable");
  });
});
