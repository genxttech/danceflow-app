import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, STUDIO_B, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  GET /api/staff/workspaces/{studioId}/schedule: the studio-wide day for owner, admin and front desk. Refusals before any read (auth, membership,
  paused, platform admin, independent, organizer) are in staffApiSlice2Refusals.test.ts; this file covers the role gate that is specific to the route
  and the data it returns.
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

const { GET } = await import("../workspaces/[studioId]/schedule/route");

function call(token: string | undefined, studioId: string, query = "date=2026-11-09") {
  return GET(
    new Request(`https://app.test/api/staff/workspaces/${studioId}/schedule?${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    { params: Promise.resolve({ studioId }) },
  );
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.reads = [];
  harness.failTable = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const DATA_TABLES = ["appointments", "clients", "instructors"];

describe("role gate", () => {
  it("instructors are refused before any appointment or client read: they keep `today`", async () => {
    for (const token of [TOKENS.instructorA, TOKENS.colleagueA, TOKENS.dualRole, TOKENS.renterInstructorA]) {
      const response = await call(token, STUDIO_A);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "role_not_permitted" });
    }
    expect(harness.reads.filter((table) => DATA_TABLES.includes(table))).toEqual([]);
  });

  it.each([
    ["owner", TOKENS.ownerA],
    ["front desk", TOKENS.frontDeskA],
  ])("%s gets the whole studio's day", async (_role, token) => {
    const response = await call(token, STUDIO_A);
    expect(response.status).toBe(200);
  });

  it("an owner of studio A cannot read studio B's schedule", async () => {
    const response = await call(TOKENS.ownerA, STUDIO_B);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "not_a_member" });
    expect(harness.reads.filter((table) => DATA_TABLES.includes(table))).toEqual([]);
  });
});

describe("the day", () => {
  it("returns every appointment of the studio's local day, in time order, and nothing from another studio or day", async () => {
    const body = await (await call(TOKENS.frontDeskA, STUDIO_A)).json();
    expect(body).toMatchObject({ studioId: STUDIO_A, date: "2026-11-09", timeZone: "America/New_York", truncated: false });
    const ids = body.appointments.map((row: { id: string }) => row.id);
    expect(ids).toEqual([
      "a0000000-0000-4000-8000-000000000006", // 12:00Z cancelled lesson
      "a0000000-0000-4000-8000-000000000001", // 15:00Z own lesson
      "a0000000-0000-4000-8000-000000000003", // 16:00Z colleague lesson
      "a0000000-0000-4000-8000-000000000004", // 17:00Z colleague class
      "a0000000-0000-4000-8000-000000000007", // 18:00Z floor rental
      "a0000000-0000-4000-8000-000000000002", // 04:59Z next day UTC = 23:59 local
    ]);
    // The next local day starts at exactly 05:00Z and is not part of this one.
    expect(ids).not.toContain("a0000000-0000-4000-8000-000000000005");
    for (const row of body.appointments) expect(row.id.startsWith("b0000000")).toBe(false);
  });

  it("shows client names and the instructor, and nothing about money, contact or referral", async () => {
    const body = await (await call(TOKENS.ownerA, STUDIO_A)).json();
    const lesson = body.appointments.find((row: { id: string }) => row.id === "a0000000-0000-4000-8000-000000000001");
    expect(lesson.client).toEqual({ id: "cli-a1", firstName: "Ana", lastName: "Own" });
    expect(lesson.partner).toEqual({ id: "cli-a3", firstName: "Pat", lastName: "Partner" });
    expect(lesson.instructor).toEqual({ id: "ins-a1", firstName: "Ida", lastName: "Instructor" });
    const text = JSON.stringify(body);
    for (const secret of ["price_amount", "payment_status", "billing_type", "secret-referral", "555-01", "phone", "referral"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("includes a floor rental with its renter, as the web calendar does", async () => {
    const body = await (await call(TOKENS.ownerA, STUDIO_A)).json();
    const rental = body.appointments.find((row: { id: string }) => row.id === "a0000000-0000-4000-8000-000000000007");
    expect(rental.appointmentType).toBe("floor_space_rental");
    expect(rental.client).toEqual({ id: "cli-rental", firstName: "Rene", lastName: "Renter" });
    expect(rental.instructor).toBeNull();
  });

  it("defaults to today in the studio's zone when no date is given", async () => {
    const response = await call(TOKENS.ownerA, STUDIO_A, "");
    expect(response.status).toBe(200);
    expect((await response.json()).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(["2026-13-01", "2026-11-31x", "yesterday", "2026-11-9"])("rejects date=%s as invalid_request before reading", async (date) => {
    const response = await call(TOKENS.ownerA, STUDIO_A, `date=${date}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(harness.reads.filter((table) => DATA_TABLES.includes(table))).toEqual([]);
  });

  it("a read failure is a 503 the app can retry, with the flat error shape", async () => {
    harness.failTable = "appointments";
    const response = await call(TOKENS.ownerA, STUDIO_A);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("service_unavailable");
    expect(Object.keys(body).sort()).toEqual(["code", "error"]);
  });
});
