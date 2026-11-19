import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression for #660: a studio staff member who is also a client must keep seeing staff-created (user_id NULL) registrations of their OWN
// client record. Staff keep the base-table query (staff policies stay after the dancer-policy cutover); non-staff read the dancer view.

type Call = { table: string; ops: Array<[string, unknown[]]> };
let calls: Call[] = [];
let staffRoleRow: unknown = null;
let dataByTable: Record<string, unknown[]> = {};

function makeClient(email: string | null) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "u1", email } } }) },
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      const result = () =>
        table === "user_studio_roles"
          ? { data: staffRoleRow, error: null }
          : { data: dataByTable[table] ?? [], error: null };
      for (const op of ["select", "eq", "not", "in", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.maybeSingle = async () => result();
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej);
      return chain;
    },
  };
}

let email: string | null = "s@x.test";
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => makeClient(email) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
vi.mock("next/link", () => ({ default: () => null }));

async function renderAccount() {
  const mod = await import("@/app/app/account/page");
  await mod.default();
}
const regCall = () => calls.find((c) => c.table === "event_registrations" || c.table === "my_event_registrations")!;
const eqs = (c: Call) => c.ops.filter(([o]) => o === "eq").map(([, a]) => a);

describe("/app/account registration count", () => {
  beforeEach(() => {
    calls = [];
    staffRoleRow = null;
    dataByTable = {};
    email = "s@x.test";
  });

  it("(a) active studio staff use the previous base-table query scoped to their own email, so staff-created rows still count", async () => {
    staffRoleRow = { studio_id: "st1" };
    dataByTable = { event_registrations: [{ id: "r4" }, { id: "r5" }] };
    await renderAccount();
    const c = regCall();
    expect(c.table).toBe("event_registrations");
    expect(eqs(c)).toEqual([["attendee_email", "s@x.test"]]);
    expect(calls.some((x) => x.table === "my_event_registrations")).toBe(false);
  });

  it("(b) a non-staff dancer reads only the view, with no base-table read and no staff path", async () => {
    staffRoleRow = null;
    dataByTable = { my_event_registrations: [{ id: "r1" }] };
    await renderAccount();
    const c = regCall();
    expect(c.table).toBe("my_event_registrations");
    expect(calls.some((x) => x.table === "event_registrations")).toBe(false);
  });

  it("(c) the staff role lookup is the viewer's own active role and the staff path never widens beyond the viewer's own email", async () => {
    staffRoleRow = { studio_id: "st1" };
    await renderAccount();
    const role = calls.find((c) => c.table === "user_studio_roles")!;
    expect(eqs(role)).toEqual([["user_id", "u1"], ["active", true]]);
    // a staff user without an email never matches a real address
    calls = [];
    email = null;
    await renderAccount();
    expect(eqs(regCall())).toEqual([["attendee_email", "__no_email__"]]);
  });
});

describe("portal registrations and tickets keep the staff path scoped to the viewer's own client record", () => {
  const src = readFileSync(path.resolve(__dirname, "../../../app/portal/[studioSlug]/page.tsx"), "utf8");
  it("staff branch: base table filtered by studio_id AND the viewer's selected client; non-staff branch: dancer view; same condition as the staff role", () => {
    expect(src).toContain("const canReturnToWorkspace = Boolean(workspaceRole);");
    expect(src).toMatch(
      /canReturnToWorkspace\s*\?\s*supabase\s*\.from\("event_registrations"\)\s*\.select\(portalRegistrationSelect\)\s*\.eq\("studio_id", typedStudio\.id\)\s*\.eq\("client_id", typedClient\.id\)\s*:\s*supabase\s*\.from\("my_event_registrations"\)\s*\.select\(portalRegistrationSelect\)\s*\.eq\("studio_id", typedStudio\.id\)\s*\)/,
    );
    expect(src).toContain('.from(canReturnToWorkspace ? "event_registration_attendees" : "my_event_registration_attendees")');
    // the workspace role lookup is the viewer's own active role for this studio
    expect(src).toMatch(/\.from\("user_studio_roles"\)\s*\.select\("role, active"\)\s*\.eq\("studio_id", typedStudio\.id\)\s*\.eq\("user_id", user\.id\)\s*\.eq\("active", true\)/);
  });
});
