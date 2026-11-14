import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUDIO_A,
  STUDIO_B,
  STUDIO_ORGANIZER,
  STUDIO_PAUSED,
  TOKENS,
  createAdminWorldClient,
  createWorldClient,
  type AuthOutcome,
} from "./staffApiWorld";

/*
  Refusals on the slice-2 routes (client lookup, client summary, attendance write), proven with the shared mock world:
  every one of these must be answered by the guard or the role check before any client or attendance data is read.
  The data-bearing role cases (instructor vs front desk vs owner scope) are in localStack.staffApiSlice2.test.ts.
*/

const harness = vi.hoisted(() => ({ authFailure: null as unknown, cookieClientCalls: 0, dataReads: 0 }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
    const world = createWorldClient(options.global.headers.Authorization.replace(/^Bearer /, ""), {
      authFailure: harness.authFailure as AuthOutcome,
    });
    // Count any read of the tables these routes own: a refusal must never reach them.
    const from = world.from.bind(world);
    world.from = ((table: string) => {
      if (table === "clients" || table === "attendance_records" || table === "client_packages") harness.dataReads += 1;
      return from(table);
    }) as typeof world.from;
    return world;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => createAdminWorldClient() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    harness.cookieClientCalls += 1;
    throw new Error("The staff API must never build a cookie client");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    throw new Error("The staff API must never read cookies");
  },
  headers: async () => new Headers(),
}));

const { GET: listClients } = await import("../workspaces/[studioId]/clients/route");
const { GET: getClient } = await import("../workspaces/[studioId]/clients/[clientId]/route");
const { PUT: putAttendance } = await import("../workspaces/[studioId]/appointments/[appointmentId]/attendance/[clientId]/route");

const ID = "a0000000-0000-4000-8000-0000000000aa";
const CLIENT = "c0000000-0000-4000-8000-0000000000bb";

function req(path: string, token?: string, init: RequestInit = {}) {
  return new Request(`https://app.test${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Idempotency-Key": "qa-refusal-key-1",
      "Content-Type": "application/json",
    },
  });
}

type Call = (token: string | undefined, studioId: string) => Promise<Response>;

const CALLS: [string, Call][] = [
  ["GET clients", (t, s) => listClients(req(`/api/staff/workspaces/${s}/clients`, t), { params: Promise.resolve({ studioId: s }) })],
  [
    "GET client summary",
    (t, s) => getClient(req(`/api/staff/workspaces/${s}/clients/${CLIENT}`, t), { params: Promise.resolve({ studioId: s, clientId: CLIENT }) }),
  ],
  [
    "PUT attendance",
    (t, s) =>
      putAttendance(
        req(`/api/staff/workspaces/${s}/appointments/${ID}/attendance/${CLIENT}`, t, {
          method: "PUT",
          body: JSON.stringify({ status: "attended" }),
        }),
        { params: Promise.resolve({ studioId: s, appointmentId: ID, clientId: CLIENT }) },
      ),
  ],
];

async function expectRefusal(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("location")).toBeNull();
  const body = await response.json();
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  // flat error shape: no nested object, nothing about the record asked for
  expect(JSON.stringify(body)).not.toContain(CLIENT);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  harness.authFailure = null;
  harness.cookieClientCalls = 0;
  harness.dataReads = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  expect(harness.cookieClientCalls).toBe(0);
  expect(harness.dataReads).toBe(0);
  vi.restoreAllMocks();
});

describe.each(CALLS)("%s refuses before reading any client data", (_name, call) => {
  it("no token and a malformed token: 401", async () => {
    await expectRefusal(await call(undefined, STUDIO_A), 401, "unauthenticated");
    await expectRefusal(await call("not-a-real-token", STUDIO_A), 401, "unauthenticated");
  });

  it("an expired session is a 401 the app answers with sign-in, not an outage", async () => {
    harness.authFailure = { status: 401 };
    await expectRefusal(await call(TOKENS.instructorA, STUDIO_A), 401, "unauthenticated");
  });

  it("an auth outage is 503, so the app does not sign the user out", async () => {
    harness.authFailure = { status: 500 };
    await expectRefusal(await call(TOKENS.instructorA, STUDIO_A), 503, "service_unavailable");
  });

  it.each([
    ["deactivated", TOKENS.deactivated],
    ["pending deletion", TOKENS.pendingDeletion],
    ["banned", TOKENS.banned],
  ])("an account that is %s: 403 account_inactive", async (_label, token) => {
    await expectRefusal(await call(token, STUDIO_A), 403, "account_inactive");
  });

  it("a platform admin: 403, even with a studio membership", async () => {
    await expectRefusal(await call(TOKENS.platformAdmin, STUDIO_A), 403, "platform_admin_unsupported");
  });

  it("another studio's user, a student, and a revoked role all get the same not_a_member", async () => {
    await expectRefusal(await call(TOKENS.instructorB, STUDIO_A), 403, "not_a_member");
    await expectRefusal(await call(TOKENS.student, STUDIO_A), 403, "not_a_member");
    await expectRefusal(await call(TOKENS.removedFromA, STUDIO_A), 403, "not_a_member");
    await expectRefusal(await call(TOKENS.instructorA, STUDIO_B), 403, "not_a_member");
  });

  it("a member of a paused studio: 403 workspace_paused", async () => {
    await expectRefusal(await call(TOKENS.instructorA, STUDIO_PAUSED), 403, "workspace_paused");
  });

  it("independent instructors and organizer roles: 403 role_not_permitted", async () => {
    await expectRefusal(await call(TOKENS.independentA, STUDIO_A), 403, "role_not_permitted");
    await expectRefusal(await call(TOKENS.organizerStaff, STUDIO_ORGANIZER), 403, "role_not_permitted");
    await expectRefusal(await call(TOKENS.organizerOwner, STUDIO_ORGANIZER), 403, "role_not_permitted");
  });
});
