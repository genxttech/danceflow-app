import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * Sallie Debolt portal-status fix: linkPortalAccessAction,
 * unlinkPortalAccessAction, and markFormerClientPortalAccessAction all
 * redirected to their success path without ever calling revalidatePath
 * first -- unlike every other mutating action in this file (e.g.
 * sendPortalInviteAction). Next.js's client-side Router Cache can then
 * serve a stale RSC payload for the destination route after the
 * Server Action's redirect(), producing "the action reports success but
 * the page still shows the old state" until the cache naturally expires.
 * This suite proves all three now call revalidatePath(returnTo)
 * immediately before their success redirect.
 *
 * linkExistingClientAccount / disconnectClientAccount (from
 * ../../../../lib/student-identity/lifecycle) are mocked out entirely --
 * their own correctness is covered separately by
 * disconnect-stale-mirror-cleanup.test.ts and the H2-B2 SQL harness; this
 * file's only job is the three actions' own control flow (does
 * revalidatePath fire before the redirect), matching this codebase's
 * existing convention of mocking collaborator modules to isolate a
 * server action's own logic (see resolvePartialRefundCreditReview.test.ts
 * in this same directory).
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const STAFF_ID = "staff-1";
const LINKED_USER_ID = "user-linked-1";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

type Fixture = {
  clients?: Row[];
  client_account_links?: Row[];
  profiles?: Row[];
  user_studio_roles?: Row[];
};

let currentTables: ReturnType<typeof buildTables>;

function buildTables(fixture: Fixture) {
  return {
    clients: table(fixture.clients ?? []),
    client_account_links: table(fixture.client_account_links ?? []),
    profiles: table(fixture.profiles ?? []),
    user_studio_roles: table(fixture.user_studio_roles ?? []),
  };
}

function setFixture(fixture: Fixture) {
  currentTables = buildTables(fixture);
  return currentTables;
}

function clientRow(overrides: Partial<Row> = {}): Row {
  return {
    id: CLIENT_ID,
    studio_id: STUDIO_ID,
    first_name: "Sallie",
    last_name: "Debolt",
    email: "sallie@example.test",
    is_independent_instructor: false,
    linked_instructor_id: null,
    ...overrides,
  };
}

function linkedAccountLinkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "link-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    user_id: LINKED_USER_ID,
    status: "linked",
    is_primary: true,
    ...overrides,
  };
}

/**
 * `.from("profiles")` also needs `.ilike()` (used by
 * findOrCreatePortalProfileByEmail's initial profiles lookup) -- the
 * shared FakeTable/createFakeEntitlementClient fixture doesn't implement
 * it (only .eq/.neq/.is/.gte/.lte/.lt/.gt/.in/.not/.or). Rather than
 * extend that shared fixture for one caller, this local, test-file-scoped
 * wrapper adds a minimal case-insensitive-exact-match `.ilike().limit()`
 * chain on top of it, matching this codebase's established precedent for
 * hand-rolled per-caller extensions (see the `withDelete` wrapper in
 * disconnect-stale-mirror-cleanup.test.ts).
 */
function createFakeClientWithIlike(tables: Record<string, FakeTable>) {
  const base = createFakeEntitlementClient(tables);
  return {
    from(tableName: string) {
      const original = base.from(tableName);
      return {
        ...original,
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          const query = original.select(cols, opts) as unknown as { ilike?: unknown };
          query.ilike = (col: string, pattern: string) => {
            const needle = String(pattern).toLowerCase();
            const matched = tables[tableName].rows.filter(
              (row) => String(row[col] ?? "").toLowerCase() === needle,
            );
            return {
              limit: (n: number) => Promise.resolve({ data: matched.slice(0, n), error: null }),
            };
          };
          return query;
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...createFakeClientWithIlike(currentTables),
    auth: {
      getUser: async () => ({ data: { user: { id: STAFF_ID } } }),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...createFakeClientWithIlike(currentTables),
    auth: {
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
      },
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: STUDIO_ID,
    studioRole: "studio_owner",
  }),
}));

// linkExistingClientAccount / disconnectClientAccount's own correctness is
// covered elsewhere (see file header) -- stubbed here so this suite tests
// only these three actions' own revalidatePath-before-redirect control flow.
vi.mock("@/lib/student-identity/lifecycle", () => ({
  linkExistingClientAccount: vi.fn(async () => {}),
  disconnectClientAccount: vi.fn(async () => {}),
  createOrRefreshClientInvitation: vi.fn(async () => ({
    token: "token-1",
    link: { id: "link-1" },
    expiresAt: "2026-12-31T00:00:00.000Z",
  })),
  resolveClientAccountConflict: vi.fn(async () => {}),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { linkPortalAccessAction, unlinkPortalAccessAction, markFormerClientPortalAccessAction } =
  await import("@/app/app/clients/[id]/actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirectDigest(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected a redirect (NEXT_REDIRECT) but none occurred.");
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest;
  }
}

beforeEach(() => {
  revalidatePathMock.mockClear();
});

describe("portal relationship actions -- revalidatePath before success redirect (Sallie Debolt fix)", () => {
  it("linkPortalAccessAction revalidates the client route before redirecting on success", async () => {
    setFixture({
      clients: [clientRow()],
      client_account_links: [],
      profiles: [{ id: LINKED_USER_ID, email: "sallie@example.test", full_name: "Sallie Debolt" }],
    });

    const digest = await expectRedirectDigest(
      linkPortalAccessAction(formDataFor({ clientId: CLIENT_ID })),
    );

    expect(digest).toContain(`/app/clients/${CLIENT_ID}`);
    expect(digest).toContain("success=portal_linked");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/clients/${CLIENT_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
  });

  it("unlinkPortalAccessAction revalidates the client route before redirecting on success", async () => {
    setFixture({
      clients: [clientRow()],
      client_account_links: [linkedAccountLinkRow()],
    });

    const digest = await expectRedirectDigest(
      unlinkPortalAccessAction(formDataFor({ clientId: CLIENT_ID })),
    );

    expect(digest).toContain(`/app/clients/${CLIENT_ID}`);
    expect(digest).toContain("success=portal_unlinked");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/clients/${CLIENT_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
  });

  it("markFormerClientPortalAccessAction revalidates the client route before redirecting on success", async () => {
    setFixture({
      clients: [clientRow()],
      client_account_links: [linkedAccountLinkRow()],
    });

    const digest = await expectRedirectDigest(
      markFormerClientPortalAccessAction(formDataFor({ clientId: CLIENT_ID })),
    );

    expect(digest).toContain(`/app/clients/${CLIENT_ID}`);
    expect(digest).toContain("success=portal_former_client");
    expect(revalidatePathMock).toHaveBeenCalledWith(`/app/clients/${CLIENT_ID}`);
    expect(revalidatePathMock).toHaveBeenCalledTimes(1);
  });

  it("linkPortalAccessAction does NOT revalidate when the link fails (error path unchanged)", async () => {
    setFixture({
      clients: [clientRow({ email: "" })], // missing email -> portal_email_required, before any link attempt
    });

    const digest = await expectRedirectDigest(
      linkPortalAccessAction(formDataFor({ clientId: CLIENT_ID })),
    );

    expect(digest).toContain("error=portal_email_required");
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });
});
