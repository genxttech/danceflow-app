import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  POST /api/staff/workspaces/{studioId}/clients/{clientId}/notes: role and input refusals, proven with the shared mock world. Every one of
  these is answered before the clients or client_activity_notes tables are touched. The write itself, tenancy and RLS are proven against
  real Postgres in localStack.staffApiClientNotes.test.ts.
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

const { POST } = await import("../workspaces/[studioId]/clients/[clientId]/notes/route");

const CLIENT = "c0000000-0000-4000-8000-0000000000bb";

function post(token: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": "note-key-0001" }, clientId = CLIENT) {
  return POST(
    new Request(`https://app.test/api/staff/workspaces/${STUDIO_A}/clients/${clientId}/notes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ studioId: STUDIO_A, clientId }) },
  );
}

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).code).toBe(code);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.dataReads = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(harness.dataReads).toBe(0);
  vi.restoreAllMocks();
});

describe("client note route: role matrix (canEditClients = owner, admin, front desk)", () => {
  it("instructors, independent instructors and organizer roles are refused with role_not_permitted", async () => {
    await expectRefusal(await post(TOKENS.instructorA, { body: "x" }), 403, "role_not_permitted");
    await expectRefusal(await post(TOKENS.colleagueA, { body: "x" }), 403, "role_not_permitted");
    await expectRefusal(await post(TOKENS.independentA, { body: "x" }), 403, "role_not_permitted");
  });

  it("a user of another studio and a student never get past membership", async () => {
    await expectRefusal(await post(TOKENS.instructorB, { body: "x" }), 403, "not_a_member");
    await expectRefusal(await post(TOKENS.student, { body: "x" }), 403, "not_a_member");
  });
});

describe("client note route: input validation (front desk and owner, before any data read)", () => {
  it.each([
    ["front desk", TOKENS.frontDeskA],
    ["owner", TOKENS.ownerA],
  ])("%s: bad input is a 400 invalid_request", async (_label, token) => {
    await expectRefusal(await post(token, { body: "x" }, {}), 400, "invalid_request"); // no Idempotency-Key
    await expectRefusal(await post(token, { body: "x" }, { "Idempotency-Key": "short" }), 400, "invalid_request");
    await expectRefusal(await post(token, "not json"), 400, "invalid_request");
    await expectRefusal(await post(token, "[1]"), 400, "invalid_request");
    await expectRefusal(await post(token, {}), 400, "invalid_request"); // body required
    await expectRefusal(await post(token, { body: "   " }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: 5 }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: "x", noteType: "secret" }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: "x", noteType: 3 }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: "x", occurredAt: "yesterday-ish" }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: "x".repeat(5001) }), 400, "invalid_request");
    await expectRefusal(await post(token, { body: "x" }, undefined, "not-a-uuid"), 400, "invalid_request");
  });
});
