// Money and entitlement hardening: the wallet must only ever ask for the signed-in account's own rows, and
// only the states that may be shown. These pin the query shape (who, which statuses) and the access-window wording.
const mockCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
jest.mock("@/lib/supabase", () => {
  const chain = (table: string): unknown => {
    const proxy: unknown = new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        return (...args: unknown[]) => {
          mockCalls.push({ table, method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { supabase: { from: (table: string) => chain(table), auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } } };
});
jest.mock("@/lib/studentDigitalContent", () => ({ loadStudentDigitalLibrary: async () => [] }));

import { digitalAccessEnded, digitalAccessLabel, loadStudentWallet } from "@/lib/studentWallet";

const studio = { studioId: "s1", clientId: "c1", studioName: "S", studioPublicName: null } as never;
const callsFor = (table: string) => mockCalls.filter((c) => c.table === table);

describe("wallet query scope", () => {
  beforeEach(() => { mockCalls.length = 0; });

  it("lists digital purchases by the signed-in account and never shows revoked access", async () => {
    await loadStudentWallet([], "a@example.test", { force: true });
    const calls = callsFor("commerce_entitlements");
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["user_id", "user-1"]);
    expect(calls.find((c) => c.method === "in")?.args).toEqual(["status", ["active", "refunded_access_retained"]]);
  });

  it("shows only pending payment requests for the linked client, and only that studio's rows", async () => {
    await loadStudentWallet([studio], "a@example.test", { force: true });
    const calls = callsFor("payments");
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["status", "pending"]);
    const ins = calls.filter((c) => c.method === "in").map((c) => c.args);
    expect(ins).toContainEqual(["client_id", ["c1"]]);
    expect(ins).toContainEqual(["studio_id", ["s1"]]);
  });

  it("asks for no studio money data at all without a linked studio", async () => {
    await loadStudentWallet([], "a@example.test", { force: true });
    for (const table of ["payments", "client_packages", "client_memberships"]) expect(callsFor(table)).toEqual([]);
  });
});

describe("guest buyers (no linked studio, no client record)", () => {
  beforeEach(() => { mockCalls.length = 0; });

  it("still finds event tickets by the account email, and digital purchases by account, without any studio link", async () => {
    await loadStudentWallet([], "Buyer@Example.test", { force: true });
    const reg = callsFor("event_registrations");
    expect(reg.find((c) => c.method === "eq")?.args).toEqual(["attendee_email", "buyer@example.test"]);
    expect(reg.find((c) => c.method === "in")?.args).toEqual(["status", ["confirmed", "checked_in", "pending", "waitlisted"]]);
    expect(callsFor("commerce_entitlements").find((c) => c.method === "eq")?.args).toEqual(["user_id", "user-1"]);
  });
});

describe("digital access window", () => {
  const now = Date.parse("2026-11-15T12:00:00Z");

  it("labels open, ended and lifetime access", () => {
    expect(digitalAccessLabel(null, now)).toBe("Lifetime access");
    expect(digitalAccessLabel("2026-12-01T00:00:00Z", now)).toMatch(/^Access expires /);
    expect(digitalAccessLabel("2026-11-01T00:00:00Z", now)).toMatch(/^Access ended /);
  });

  it("treats the end instant as ended, and a bad date as not ended", () => {
    expect(digitalAccessEnded("2026-11-15T12:00:00Z", now)).toBe(true);
    expect(digitalAccessEnded("2026-11-15T12:00:01Z", now)).toBe(false);
    expect(digitalAccessEnded("not a date", now)).toBe(false);
    expect(digitalAccessEnded(null, now)).toBe(false);
  });
});
