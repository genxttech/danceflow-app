import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  GET /api/staff/workspaces/{studioId}/clients/{clientId}/notes: role and input refusals with the shared mock world, all answered before the
  clients or client_activity_notes tables are touched. Ordering, paging, tenancy and RLS are proven against real Postgres in
  localStack.staffApiClientNotesRead.test.ts.
*/

const harness = vi.hoisted(() => ({ dataReads: 0 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const world = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {});
    const from = world.from.bind(world);
    world.from = ((table: string) => {
      if (table === "clients" || table === "client_activity_notes") harness.dataReads += 1;
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

const { GET } = await import("../workspaces/[studioId]/clients/[clientId]/notes/route");

const CLIENT = "c0000000-0000-4000-8000-0000000000bb";

function get(token: string, query = "", clientId = CLIENT) {
  return GET(new Request(`https://app.test/api/staff/workspaces/${STUDIO_A}/clients/${clientId}/notes${query}`, { headers: { Authorization: `Bearer ${token}` } }), {
    params: Promise.resolve({ studioId: STUDIO_A, clientId }),
  });
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).code).toBe(code);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  // the read route is not behind the write guard: no policy and no app header are needed, so make sure none leaks in
  delete process.env.STAFF_API_WRITE_POLICY;
  harness.dataReads = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(harness.dataReads).toBe(0);
  vi.restoreAllMocks();
});

describe("client notes read route refusals", () => {
  it("instructors, independent instructors and organizer roles cannot read client notes (canViewClients only)", async () => {
    await expectRefusal(await get(TOKENS.instructorA), 403, "role_not_permitted");
    await expectRefusal(await get(TOKENS.colleagueA), 403, "role_not_permitted");
    await expectRefusal(await get(TOKENS.independentA), 403, "role_not_permitted");
  });

  it("another studio's staff and students are not_a_member; unauthenticated is 401", async () => {
    await expectRefusal(await get(TOKENS.instructorB), 403, "not_a_member");
    await expectRefusal(await get(TOKENS.student), 403, "not_a_member");
    await expectRefusal(await get("not-a-real-token"), 401, "unauthenticated");
  });

  it.each([
    ["front desk", TOKENS.frontDeskA],
    ["owner", TOKENS.ownerA],
  ])("%s: bad input is a 400 invalid_request before any read", async (_label, token) => {
    await expectRefusal(await get(token, "", "not-a-uuid"), 400, "invalid_request");
    for (const query of ["?limit=0", "?limit=51", "?limit=abc", "?limit=1.5", "?cursor=garbage", "?cursor=e30"]) {
      await expectRefusal(await get(token, query), 400, "invalid_request");
    }
  });
});
