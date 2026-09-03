import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * H2-C2: unlinkPortalAccessAction and markFormerClientPortalAccessAction
 * both compute a specific relationship's target userId and pass it into
 * disconnectClientAccount, scoping the disconnect to exactly the relationship
 * staff intended to remove instead of every client_account_links row for
 * that client.
 *
 * The initial H2-C2 fix targeted resolution via getPrimaryLinkedUserId,
 * which only ever resolves relationship_type === "self" rows (is_primary is
 * never set on guardian/parent/billing_contact/dependent_manager rows --
 * see the "Account relationship" select in page.tsx). That incorrectly
 * treated a client linked via exactly one non-self relationship (a normal,
 * staff-selectable, common case for a minor's account) as ambiguous and
 * permanently blocked disconnecting it. resolveUnlinkTargetUserId (see
 * actions.ts) fixes this by distinguishing actual ambiguity (multiple
 * currently-linked rows with no single resolvable primary) from mere
 * absence of a primary flag (exactly one currently-linked row -- use it
 * regardless of relationship_type or is_primary).
 *
 * This suite proves both actions (a) resolve the correct target across all
 * of self-only, guardian-only, and other non-self-only relationship shapes,
 * (b) target only the primary when multiple rows are linked and exactly one
 * is primary, (c) fail closed -- never calling disconnectClientAccount --
 * when multiple linked rows exist with no single resolvable primary
 * (including the malformed case of more than one row flagged primary), and
 * (d) ignore historical disconnected/former_client rows when resolving the
 * current target.
 *
 * disconnectClientAccount's own row-scoping correctness is covered directly
 * against a real (fake) client_account_links table in
 * disconnect-stale-mirror-cleanup.test.ts's "H2-C2 relationship-scoped
 * unlink" describe block; this file's job is only these two actions' own
 * control flow (what they resolve, what they pass through, and when they
 * refuse to act), mirroring this codebase's established convention of
 * mocking disconnectClientAccount out entirely to isolate a server action's
 * own logic (see portalRelationshipRevalidate.test.ts in this same
 * directory).
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const STAFF_ID = "staff-1";
const USER_SELF = "user-self-1";
const USER_GUARDIAN = "user-guardian-1";
const USER_GUARDIAN_2 = "user-guardian-2";
const USER_BILLING_CONTACT = "user-billing-1";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

type Fixture = {
  clients?: Row[];
  client_account_links?: Row[];
  user_studio_roles?: Row[];
};

let currentTables: ReturnType<typeof buildTables>;

function buildTables(fixture: Fixture) {
  return {
    clients: table(fixture.clients ?? []),
    client_account_links: table(fixture.client_account_links ?? []),
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
    first_name: "Test",
    last_name: "Client",
    email: "test-client@example.test",
    is_independent_instructor: false,
    linked_instructor_id: null,
    ...overrides,
  };
}

function linkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `link-${Math.random().toString(36).slice(2)}`,
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    status: "linked",
    relationship_type: "self",
    is_primary: false,
    ...overrides,
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...createFakeEntitlementClient(currentTables),
    auth: {
      getUser: async () => ({ data: { user: { id: STAFF_ID } } }),
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...createFakeEntitlementClient(currentTables),
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

const disconnectClientAccountMock = vi.fn(async (...args: unknown[]) => {
  void args;
});

vi.mock("@/lib/student-identity/lifecycle", () => ({
  linkExistingClientAccount: vi.fn(async () => {}),
  disconnectClientAccount: (params: unknown) => disconnectClientAccountMock(params),
  createOrRefreshClientInvitation: vi.fn(async () => ({
    token: "token-1",
    link: { id: "link-1" },
    expiresAt: "2026-12-31T00:00:00.000Z",
  })),
  resolveClientAccountConflict: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { unlinkPortalAccessAction, markFormerClientPortalAccessAction } = await import(
  "@/app/app/clients/[id]/actions"
);

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
  disconnectClientAccountMock.mockClear();
});

type ActionCase = {
  label: string;
  run: (formData: FormData) => Promise<unknown>;
  successCode: string;
  ambiguousCode: string;
  extraCallArgs: Record<string, unknown>;
};

const ACTIONS: ActionCase[] = [
  {
    label: "unlinkPortalAccessAction",
    run: unlinkPortalAccessAction,
    successCode: "success=portal_unlinked",
    ambiguousCode: "error=portal_unlink_ambiguous",
    extraCallArgs: {},
  },
  {
    label: "markFormerClientPortalAccessAction",
    run: markFormerClientPortalAccessAction,
    successCode: "success=portal_former_client",
    ambiguousCode: "error=portal_former_client_ambiguous",
    extraCallArgs: { formerClient: true },
  },
];

describe.each(ACTIONS)(
  "$label -- H2-C2 relationship-scoped unlink target resolution",
  ({ run, successCode, ambiguousCode, extraCallArgs }) => {
    it("1: exactly one linked self row -- proceeds, targets that user", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-self", user_id: USER_SELF, relationship_type: "self", is_primary: true }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(successCode);
      expect(disconnectClientAccountMock).toHaveBeenCalledTimes(1);
      expect(disconnectClientAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_SELF, ...extraCallArgs }),
      );
    });

    it("2: exactly one linked guardian row (no self relationship at all) -- proceeds, targets that guardian", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-guardian", user_id: USER_GUARDIAN, relationship_type: "guardian", is_primary: false }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(successCode);
      expect(disconnectClientAccountMock).toHaveBeenCalledTimes(1);
      expect(disconnectClientAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_GUARDIAN, ...extraCallArgs }),
      );
    });

    it("3: exactly one linked non-self, non-guardian row (billing_contact) -- proceeds, targets that user", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({
            id: "link-billing",
            user_id: USER_BILLING_CONTACT,
            relationship_type: "billing_contact",
            is_primary: false,
          }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(successCode);
      expect(disconnectClientAccountMock).toHaveBeenCalledTimes(1);
      expect(disconnectClientAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_BILLING_CONTACT, ...extraCallArgs }),
      );
    });

    it("4: self + guardian with one clear primary -- targets only the primary (self)", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-self", user_id: USER_SELF, relationship_type: "self", is_primary: true }),
          linkRow({ id: "link-guardian", user_id: USER_GUARDIAN, relationship_type: "guardian", is_primary: false }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(successCode);
      expect(disconnectClientAccountMock).toHaveBeenCalledTimes(1);
      expect(disconnectClientAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_SELF, ...extraCallArgs }),
      );
    });

    it("5: two guardians, neither primary -- fails closed, never calls disconnectClientAccount", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-guardian-1", user_id: USER_GUARDIAN, relationship_type: "guardian", is_primary: false }),
          linkRow({ id: "link-guardian-2", user_id: USER_GUARDIAN_2, relationship_type: "guardian", is_primary: false }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(ambiguousCode);
      expect(disconnectClientAccountMock).not.toHaveBeenCalled();
    });

    it("6: multiple linked rows with more than one flagged primary (malformed / no unique primary) -- fails closed", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-self", user_id: USER_SELF, relationship_type: "self", is_primary: true }),
          linkRow({ id: "link-guardian", user_id: USER_GUARDIAN, relationship_type: "guardian", is_primary: true }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(ambiguousCode);
      expect(disconnectClientAccountMock).not.toHaveBeenCalled();
    });

    it("7: historical disconnected/former_client rows are ignored when resolving the current target", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({
            id: "link-guardian",
            user_id: USER_GUARDIAN,
            relationship_type: "guardian",
            is_primary: false,
            status: "linked",
          }),
          linkRow({
            id: "link-self-old",
            user_id: USER_SELF,
            relationship_type: "self",
            is_primary: true,
            status: "disconnected",
          }),
          linkRow({
            id: "link-guardian-2-old",
            user_id: USER_GUARDIAN_2,
            relationship_type: "guardian",
            is_primary: false,
            status: "former_client",
          }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(successCode);
      expect(disconnectClientAccountMock).toHaveBeenCalledTimes(1);
      expect(disconnectClientAccountMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_GUARDIAN, ...extraCallArgs }),
      );
    });

    it("8: sole linked row has a null user_id (malformed) -- fails closed rather than passing userId: null through", async () => {
      setFixture({
        clients: [clientRow()],
        client_account_links: [
          linkRow({ id: "link-malformed", user_id: null, relationship_type: "guardian", is_primary: false }),
        ],
      });

      const digest = await expectRedirectDigest(run(formDataFor({ clientId: CLIENT_ID })));

      expect(digest).toContain(ambiguousCode);
      expect(disconnectClientAccountMock).not.toHaveBeenCalled();
    });
  },
);
