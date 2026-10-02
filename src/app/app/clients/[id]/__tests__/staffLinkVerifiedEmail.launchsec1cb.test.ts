import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * LAUNCH-SEC-1C-B: staff linking of an existing DanceFlow account by email
 * requires that the target account verified and bound this exact email.
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const TARGET_ID = "user-target-1";

let tables: Record<string, FakeTable>;
let targetVerifiedEmail: string | null = null;

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function withIlike(base: ReturnType<typeof createFakeEntitlementClient>) {
  return {
    from(tableName: string) {
      const original = base.from(tableName);
      return {
        ...original,
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          const query = original.select(cols, opts) as unknown as { ilike?: unknown };
          query.ilike = (col: string, pattern: string) => {
            const matched = tables[tableName].rows.filter(
              (row) => String(row[col] ?? "").toLowerCase() === String(pattern).toLowerCase(),
            );
            return { limit: (n: number) => Promise.resolve({ data: matched.slice(0, n), error: null }) };
          };
          return query;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...withIlike(createFakeEntitlementClient(tables)),
    auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...withIlike(createFakeEntitlementClient(tables)),
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  }),
}));

vi.mock("@/lib/auth/verifiedIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/verifiedIdentity")>()),
  getVerifiedEmailForUser: async (_admin: unknown, userId: string) =>
    userId === TARGET_ID ? targetVerifiedEmail : null,
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO_ID, studioRole: "studio_owner" }),
}));

const linkExistingClientAccount = vi.fn(async () => {});
const resolveClientAccountConflict = vi.fn(async () => {});
vi.mock("@/lib/student-identity/lifecycle", () => ({
  linkExistingClientAccount: (...args: unknown[]) => linkExistingClientAccount(...(args as [])),
  disconnectClientAccount: vi.fn(async () => {}),
  createOrRefreshClientInvitation: vi.fn(),
  resolveClientAccountConflict: (...args: unknown[]) => resolveClientAccountConflict(...(args as [])),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { linkPortalAccessAction, resolvePortalConflictAction } = await import("@/app/app/clients/[id]/actions");

async function digestOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (digest) return digest;
    throw error;
  }
  throw new Error("expected redirect");
}

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  tables = {
    clients: table([{ id: CLIENT_ID, studio_id: STUDIO_ID, first_name: "Pat", last_name: "Lee", email: "pat@example.test", is_independent_instructor: false, linked_instructor_id: null }]),
    client_account_links: table([]),
    profiles: table([{ id: TARGET_ID, email: "pat@example.test", full_name: "Pat Lee" }]),
    user_studio_roles: table([]),
  };
  targetVerifiedEmail = null;
  linkExistingClientAccount.mockClear();
  resolveClientAccountConflict.mockClear();
});

describe("LAUNCH-SEC-1C-B staff portal linking", () => {
  it("refuses to link an account that has not verified the client's email", async () => {
    const digest = await digestOf(linkPortalAccessAction(form({ clientId: CLIENT_ID })));
    expect(digest).toContain("error=portal_account_unverified");
    expect(linkExistingClientAccount).not.toHaveBeenCalled();
  });

  it("refuses when the target verified a different email", async () => {
    targetVerifiedEmail = "someone-else@example.test";
    const digest = await digestOf(linkPortalAccessAction(form({ clientId: CLIENT_ID })));
    expect(digest).toContain("error=portal_account_unverified");
    expect(linkExistingClientAccount).not.toHaveBeenCalled();
  });

  it("links when the target verified and bound exactly the client's email", async () => {
    targetVerifiedEmail = "pat@example.test";
    const digest = await digestOf(linkPortalAccessAction(form({ clientId: CLIENT_ID })));
    expect(digest).toContain("success=portal_linked");
    expect(linkExistingClientAccount).toHaveBeenCalledTimes(1);
  });

  it("conflict resolution by matching account needs the same verified email", async () => {
    const digest = await digestOf(
      resolvePortalConflictAction(form({ clientId: CLIENT_ID, resolution: "link_matching_account" })),
    );
    expect(digest).toContain("error=portal_account_unverified");
    expect(resolveClientAccountConflict).not.toHaveBeenCalled();
  });
});
