import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUDIO_A, TOKENS, createAdminWorldClient, createWorldClient } from "./staffApiWorld";

/*
  POST /api/staff/workspaces/{studioId}/clients (quick add): role and input refusals with the shared mock world. Every one is answered before
  the clients table is touched. Duplicate detection, the stored row, tenancy and RLS are proven against real Postgres in
  localStack.staffApiClientCreate.test.ts.
*/

const harness = vi.hoisted(() => ({ dataReads: 0 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const world = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {});
    const from = world.from.bind(world);
    world.from = ((table: string) => {
      if (table === "clients") harness.dataReads += 1;
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

const { POST } = await import("../workspaces/[studioId]/clients/route");

const CLIENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function post(token: string, body: unknown, headers: Record<string, string> = { "Idempotency-Key": "create-key-0001", "X-DanceFlow-App": "business/0.2.0/3/android" }) {
  return POST(
    new Request(`https://app.test/api/staff/workspaces/${STUDIO_A}/clients`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      // a default clientId is added unless the case sets the key itself (even to undefined)
      body: typeof body === "string" ? body : JSON.stringify(body && typeof body === "object" && !("clientId" in body) ? { clientId: CLIENT_ID, ...body } : body),
    }),
    { params: Promise.resolve({ studioId: STUDIO_A }) },
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
  process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["clientCreate"] });
  harness.dataReads = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(harness.dataReads).toBe(0);
  vi.restoreAllMocks();
});

const ok = { firstName: "Ana", lastName: "Rivera", phone: "555-010-0100" };

describe("quick-add route: the write guard (kill switch and app version) runs after identity and before the role check", () => {
  it("no policy, the capability not listed, or an unreadable policy: 403 writes_disabled (fail closed)", async () => {
    delete process.env.STAFF_API_WRITE_POLICY;
    await expectRefusal(await post(TOKENS.frontDeskA, ok), 403, "writes_disabled");
    process.env.STAFF_API_WRITE_POLICY = JSON.stringify({ enabled: ["clientNotes"] });
    await expectRefusal(await post(TOKENS.ownerA, ok), 403, "writes_disabled");
    process.env.STAFF_API_WRITE_POLICY = "not json";
    await expectRefusal(await post(TOKENS.ownerA, ok), 403, "writes_disabled");
  });

  it("a missing or foreign app header: 426 upgrade_required", async () => {
    await expectRefusal(await post(TOKENS.frontDeskA, ok, { "Idempotency-Key": "create-key-0001" }), 426, "upgrade_required");
    await expectRefusal(await post(TOKENS.frontDeskA, ok, { "Idempotency-Key": "create-key-0001", "X-DanceFlow-App": "student/1/1/android" }), 426, "upgrade_required");
  });

  it("identity refusals still win over the guard", async () => {
    delete process.env.STAFF_API_WRITE_POLICY;
    await expectRefusal(await post(TOKENS.instructorB, ok), 403, "not_a_member");
    await expectRefusal(await post("not-a-real-token", ok), 401, "unauthenticated");
  });
});

describe("quick-add route: roles (canEditClients = owner, admin, front desk)", () => {
  it("instructors and independent instructors are role_not_permitted; another studio's staff and students are not_a_member", async () => {
    await expectRefusal(await post(TOKENS.instructorA, ok), 403, "role_not_permitted");
    await expectRefusal(await post(TOKENS.colleagueA, ok), 403, "role_not_permitted");
    await expectRefusal(await post(TOKENS.independentA, ok), 403, "role_not_permitted");
    await expectRefusal(await post(TOKENS.instructorB, ok), 403, "not_a_member");
    await expectRefusal(await post(TOKENS.student, ok), 403, "not_a_member");
  });
});

describe("quick-add route: input validation (front desk and owner, before any data read)", () => {
  it.each([
    ["front desk", TOKENS.frontDeskA],
    ["owner", TOKENS.ownerA],
  ])("%s: bad input is a 400 invalid_request", async (_label, token) => {
    await expectRefusal(await post(token, ok, { "X-DanceFlow-App": "business/0.2.0/3/android" }), 400, "invalid_request"); // no Idempotency-Key
    await expectRefusal(await post(token, ok, { "Idempotency-Key": "short", "X-DanceFlow-App": "business/0.2.0/3/android" }), 400, "invalid_request");
    await expectRefusal(await post(token, "not json"), 400, "invalid_request");
    await expectRefusal(await post(token, "[1]"), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, clientId: undefined }), 400, "invalid_request"); // clientId required
    await expectRefusal(await post(token, { ...ok, clientId: "not-a-uuid" }), 400, "invalid_request");
    await expectRefusal(await post(token, { lastName: "Rivera", phone: "555-010-0100" }), 400, "invalid_request"); // first name required
    await expectRefusal(await post(token, { firstName: "Ana", phone: "555-010-0100" }), 400, "invalid_request"); // last name required
    await expectRefusal(await post(token, { firstName: "Ana", lastName: "Rivera" }), 400, "invalid_request"); // phone or email required
    await expectRefusal(await post(token, { ...ok, firstName: "x".repeat(81) }), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, email: "not-an-email" }), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, phone: "12" }), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, note: "n".repeat(3001) }), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, firstName: 5 }), 400, "invalid_request");
    await expectRefusal(await post(token, { ...ok, allowDuplicatePhone: "yes" }), 400, "invalid_request");
  });
});
