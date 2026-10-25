import { beforeEach, describe, expect, it, vi } from "vitest";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "22222222-2222-4222-8222-222222222222";
const ADMIN_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLAIN_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_TENANT_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: vi.fn(), get: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
class Redirect extends Error { constructor(public to: string) { super(to); } }
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Redirect(to); } }));
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "admin" } } }) } }) }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({
  getVerifiedEmailForUser: async (_c: unknown, id: string) => `${id}@example.com`,
  verifiedEmailMatches: (verified: string | null, email: string) => verified === email,
}));
const linked: Array<{ studioId: string; clientId: string; userId: string }> = [];
vi.mock("@/lib/student-identity/lifecycle", () => ({
  linkExistingClientAccount: async (a: { studioId: string; clientId: string; userId: string }) => { linked.push(a); },
}));

type Row = Record<string, unknown>;
let profiles: Map<string, Row>;
let upserts: Row[];
let clientsByStudio: Record<string, Row[]>;

function admin() {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: [
      { id: ADMIN_USER, email: `${ADMIN_USER}@example.com` },
      { id: PLAIN_USER, email: `${PLAIN_USER}@example.com` },
      { id: OTHER_TENANT_USER, email: `${OTHER_TENANT_USER}@example.com` },
    ] }, error: null }) } },
    from(table: string) {
      const state: { studio?: string } = {};
      const b: Record<string, unknown> = {
        select: () => b,
        not: () => b,
        eq: (_c: string, v: string) => { state.studio = v; return b; },
        upsert: async (row: Row) => {
          upserts.push(row);
          // Postgres ON CONFLICT DO UPDATE semantics: only the supplied columns change, the rest keep their stored values
          profiles.set(String(row.id), { ...(profiles.get(String(row.id)) ?? { platform_role: null }), ...row });
          return { error: null };
        },
        insert: async () => ({ error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: table === "clients" ? clientsByStudio[state.studio ?? ""] ?? [] : [], error: null }),
      };
      return b;
    },
  };
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));

import { repairStudioPortalLinksAction } from "../actions";

const form = (studioId: string) => { const f = new FormData(); f.set("studioId", studioId); return f; };
const run = async (studioId: string) => { try { await repairStudioPortalLinksAction(form(studioId)); } catch (e) { if (!(e instanceof Redirect)) throw e; } };

beforeEach(() => {
  linked.length = 0;
  upserts = [];
  profiles = new Map([[ADMIN_USER, { id: ADMIN_USER, platform_role: "platform_admin" }]]);
  clientsByStudio = {
    [STUDIO]: [
      { id: "c-admin", first_name: "Ada", last_name: "Admin", email: `${ADMIN_USER}@example.com` },
      { id: "c-plain", first_name: "Pat", last_name: "Plain", email: `${PLAIN_USER}@example.com` },
    ],
    [OTHER_STUDIO]: [{ id: "c-other", first_name: "Olive", last_name: "Other", email: `${OTHER_TENANT_USER}@example.com` }],
  };
});

describe("portal-link repair never writes platform_role", () => {
  it("keeps an existing platform admin's role when the admin is also a client", async () => {
    await run(STUDIO);
    expect(profiles.get(ADMIN_USER)?.platform_role).toBe("platform_admin");
  });

  it("no profile upsert carries a platform_role key at all (never demotes, never grants)", async () => {
    await run(STUDIO);
    expect(upserts.length).toBeGreaterThan(0);
    for (const row of upserts) expect(Object.prototype.hasOwnProperty.call(row, "platform_role")).toBe(false);
    expect(profiles.get(PLAIN_USER)?.platform_role).toBeNull();
  });

  it("still links a plain client", async () => {
    await run(STUDIO);
    expect(linked).toContainEqual({ studioId: STUDIO, clientId: "c-plain", userId: PLAIN_USER, invitedEmail: `${PLAIN_USER}@example.com` });
  });

  it("tenant isolation is unchanged: only the requested studio's clients are linked", async () => {
    await run(STUDIO);
    expect(linked.every((l) => l.studioId === STUDIO)).toBe(true);
    expect(linked.some((l) => l.userId === OTHER_TENANT_USER)).toBe(false);
    expect(profiles.has(OTHER_TENANT_USER)).toBe(false);
  });
});
