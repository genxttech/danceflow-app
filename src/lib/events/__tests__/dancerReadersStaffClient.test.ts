import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #660: a studio staff member who is also a client must keep seeing staff-created (user_id NULL) registrations of their OWN
// client record. Staff keep the base-table query (staff policies stay after the dancer-policy cutover); everyone reads the dancer view too.

type Call = { table: string; ops: Array<[string, unknown[]]> };
let calls: Call[] = [];
let staffRoleRow: unknown = null;
let dataByTable: Record<string, unknown[]> = {};
let email: string | null = "s@x.test";

const STUDIO = { id: "st1", name: "Studio", slug: "studio", public_name: null };

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1", email } } }) },
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const list = () => ({ data: dataByTable[table] ?? [], error: null });
      const one = async () =>
        table === "user_studio_roles"
          ? { data: staffRoleRow, error: null }
          : table === "studios"
            ? { data: STUDIO, error: null }
            : { data: null, error: null };
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, op: string) {
            if (op === "single" || op === "maybeSingle") return one;
            if (op === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(list()).then(res, rej);
            return (...args: unknown[]) => {
              call.ops.push([op, args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => makeClient() }));
vi.mock("@/lib/schedule/groupClassRoster", () => ({ getClassEnrollmentAppointmentsForClient: async () => ({ upcoming: [], recent: [] }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("next/link", () => ({ default: () => null }));

const eqs = (c: Call) => c.ops.filter(([o]) => o === "eq").map(([, a]) => a);
const tables = () => calls.map((c) => c.table);
const callOf = (t: string) => calls.find((c) => c.table === t);

function reset() {
  calls = [];
  staffRoleRow = null;
  dataByTable = {};
  email = "s@x.test";
}

async function renderAccount() {
  const mod = await import("@/app/app/account/page");
  return JSON.stringify(await mod.default());
}

describe("/app/account registration count", () => {
  beforeEach(reset);

  it("(a) active staff also run the base-table query scoped to their own email and count the union with the view", async () => {
    staffRoleRow = { studio_id: "stA" };
    dataByTable = { my_event_registrations: [{ id: "b1" }], event_registrations: [{ id: "a1" }, { id: "b1" }] };
    const out = await renderAccount();
    expect(eqs(callOf("event_registrations")!)).toEqual([["attendee_email", "s@x.test"]]);
    expect(tables()).toContain("my_event_registrations");
    // union of ids: a1, b1 = 2 (not 3)
    expect(out).toContain('"children":2');
  });

  it("(a2) cross-studio: staff of studio A keep their own studio B registration that only the view returns", async () => {
    staffRoleRow = { studio_id: "stA" };
    dataByTable = { my_event_registrations: [{ id: "b1" }], event_registrations: [] };
    expect(await renderAccount()).toContain('"children":1');
  });

  it("(b) a non-staff dancer reads only the view: no base-table read, no staff path", async () => {
    dataByTable = { my_event_registrations: [{ id: "r1" }], event_registrations: [{ id: "x" }] };
    const out = await renderAccount();
    expect(tables()).not.toContain("event_registrations");
    expect(out).toContain('"children":1');
  });

  it("(c) the role lookup is the viewer's own active role, and a null email never matches a real address", async () => {
    staffRoleRow = { studio_id: "stA" };
    email = null;
    await renderAccount();
    expect(eqs(callOf("user_studio_roles")!)).toEqual([["user_id", "u1"], ["active", true]]);
    expect(eqs(callOf("event_registrations")!)).toEqual([["attendee_email", "__no_email__"]]);
  });
});

describe("portal registrations and tickets", () => {
  beforeEach(reset);

  const links = (ids: string[]) =>
    ids.map((id, i) => ({
      client_id: id,
      relationship_type: "self",
      is_primary: i === 0,
      clients: { id, first_name: "C", last_name: id, email: "s@x.test", is_independent_instructor: false },
    }));

  async function renderPortal(client?: string) {
    const mod = await import("@/app/portal/[studioSlug]/page");
    await mod.default({
      params: Promise.resolve({ studioSlug: "studio" }),
      searchParams: Promise.resolve(client ? { client } : {}),
    } as never);
  }

  it("staff who is also a client: base tables scoped to studio + own client, so a staff-created user_id NULL registration and its tickets are read", async () => {
    staffRoleRow = { role: "front_desk", active: true };
    dataByTable = { client_account_links: links(["c1"]), event_registrations: [{ id: "r4", events: null }] };
    await renderPortal();
    const reg = callOf("event_registrations")!;
    expect(eqs(reg)).toEqual([["studio_id", "st1"], ["client_id", "c1"]]);
    expect(callOf("event_registration_attendees")).toBeTruthy();
    expect(tables()).not.toContain("my_event_registrations");
    expect(tables()).not.toContain("my_event_registration_attendees");
  });

  it("non-staff dancer: only the views, filtered by studio, never the base tables", async () => {
    dataByTable = { client_account_links: links(["c1"]), my_event_registrations: [{ id: "r1", events: null }] };
    await renderPortal();
    expect(eqs(callOf("my_event_registrations")!)).toEqual([["studio_id", "st1"]]);
    expect(callOf("my_event_registration_attendees")).toBeTruthy();
    expect(tables()).not.toContain("event_registrations");
    expect(tables()).not.toContain("event_registration_attendees");
  });

  it("a client id from the query string cannot select another client: clients come only from the viewer's own linked account links", async () => {
    staffRoleRow = { role: "front_desk", active: true };
    dataByTable = { client_account_links: links(["c1"]), event_registrations: [{ id: "r4", events: null }] };
    await renderPortal("c-someone-else");
    expect(eqs(callOf("client_account_links")!)).toEqual([["studio_id", "st1"], ["user_id", "u1"], ["status", "linked"]]);
    expect(eqs(callOf("event_registrations")!)).toEqual([["studio_id", "st1"], ["client_id", "c1"]]);
  });

  it("cross-studio: the staff decision is the viewer's own active role for THIS studio only", async () => {
    staffRoleRow = null; // staff elsewhere, nothing for st1
    dataByTable = { client_account_links: links(["c1"]), my_event_registrations: [] };
    await renderPortal();
    expect(eqs(callOf("user_studio_roles")!)).toEqual([["studio_id", "st1"], ["user_id", "u1"], ["active", true]]);
    expect(tables()).not.toContain("event_registrations");
  });
});
