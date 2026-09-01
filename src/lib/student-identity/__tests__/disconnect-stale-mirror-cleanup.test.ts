import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * H2-B3: regression coverage for the legacy clients.portal_user_id mirror
 * cleanup added to every disconnect/revoke path (disconnectClientAccount,
 * leaveStudioRelationship, deleteDanceFlowAccount). Before H2-B3, all three
 * transitioned client_account_links away from 'linked' without ever
 * touching the legacy mirror column, leaving it stale even though H2-B2's
 * RLS cutover no longer authorizes through it -- exactly the scenario the
 * deterministic local SQL harness's T-h2b2-stale-mirror fixture models.
 *
 * Reuses the existing generic FakeTable/createFakeEntitlementClient
 * query-builder fake (already proven against .update().eq().eq().select()
 * and .in() chains) rather than hand-rolling a new one.
 */

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const USER_A = "user-a";
const USER_OTHER = "user-other";

let clientsTable: FakeTable;
let linksTable: FakeTable;
let userAccountStatusTable: FakeTable;
let eventRegistrationsTable: FakeTable;
let legalAgreementAcceptancesTable: FakeTable;
let mobilePushTokensTable: FakeTable;
let mobileNotificationLogTable: FakeTable;
let mobileNotificationPreferencesTable: FakeTable;
let userFavoritesTable: FakeTable;
let dancerPartnerProfilesTable: FakeTable;
let dancerProfilesTable: FakeTable;
let profilesTable: FakeTable;
let accountDeletionAuditTable: FakeTable;
let deleteUserCalls: string[];

function clientRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    studio_id: STUDIO_A,
    portal_user_id: null,
    status: "active",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function linkRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    studio_id: STUDIO_A,
    client_id: CLIENT_A,
    user_id: USER_A,
    status: "linked",
    ...overrides,
  };
}

/**
 * deleteDanceFlowAccount's deleteUserRows() helper issues
 * `.from(table).delete().eq(column, userId)`, which the shared
 * FakeTable/createFakeEntitlementClient fixture doesn't implement (it only
 * covers select/insert/update, the surface every other current caller
 * needs). Rather than extend that shared fixture for one caller, this
 * local, test-file-scoped wrapper adds a minimal `.delete().eq()` chain on
 * top of it.
 */
function withDelete(table: FakeTable) {
  return {
    delete: () => {
      const filters: Array<{ col: string; val: unknown }> = [];
      const builder = {
        eq(col: string, val: unknown) {
          filters.push({ col, val });
          return builder;
        },
        then(onFulfilled: (v: { error: null }) => unknown) {
          table.rows = table.rows.filter((row) => !filters.every((f) => row[f.col] === f.val));
          return Promise.resolve({ error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
    // Not real onConflict/merge semantics -- just enough for
    // deleteDanceFlowAccount's user_account_status write, whose content
    // this suite does not assert on, to complete without error.
    upsert: (payload: Row) => {
      table.rows.push(payload);
      return Promise.resolve({ error: null });
    },
  };
}

function createFakeAdminClientWithDelete(tables: Record<string, FakeTable>) {
  const base = createFakeEntitlementClient(tables);
  return {
    from(table: string) {
      return {
        ...base.from(table),
        ...withDelete(tables[table]),
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    ...createFakeAdminClientWithDelete({
      get clients() {
        return clientsTable;
      },
      get client_account_links() {
        return linksTable;
      },
      get user_account_status() {
        return userAccountStatusTable;
      },
      get event_registrations() {
        return eventRegistrationsTable;
      },
      get legal_agreement_acceptances() {
        return legalAgreementAcceptancesTable;
      },
      get mobile_push_tokens() {
        return mobilePushTokensTable;
      },
      get mobile_notification_log() {
        return mobileNotificationLogTable;
      },
      get mobile_notification_preferences() {
        return mobileNotificationPreferencesTable;
      },
      get user_favorites() {
        return userFavoritesTable;
      },
      get dancer_partner_profiles() {
        return dancerPartnerProfilesTable;
      },
      get dancer_profiles() {
        return dancerProfilesTable;
      },
      get profiles() {
        return profilesTable;
      },
      get account_deletion_audit() {
        return accountDeletionAuditTable;
      },
    } as unknown as Record<string, FakeTable>),
    auth: {
      admin: {
        deleteUser: async (userId: string) => {
          deleteUserCalls.push(userId);
          return { error: null };
        },
      },
    },
  }),
}));

const { disconnectClientAccount } = await import("@/lib/student-identity/lifecycle");
const { leaveStudioRelationship, deleteDanceFlowAccount } = await import(
  "@/lib/student-identity/account-controls"
);

beforeEach(() => {
  clientsTable = new FakeTable();
  linksTable = new FakeTable();
  userAccountStatusTable = new FakeTable();
  eventRegistrationsTable = new FakeTable();
  legalAgreementAcceptancesTable = new FakeTable();
  mobilePushTokensTable = new FakeTable();
  mobileNotificationLogTable = new FakeTable();
  mobileNotificationPreferencesTable = new FakeTable();
  userFavoritesTable = new FakeTable();
  dancerPartnerProfilesTable = new FakeTable();
  dancerProfilesTable = new FakeTable();
  profilesTable = new FakeTable();
  accountDeletionAuditTable = new FakeTable();
  deleteUserCalls = [];
});

describe("disconnectClientAccount -- H2-B3 stale-mirror cleanup", () => {
  it("A: clears clients.portal_user_id when it matches the exact user just disconnected", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_A })];
    linksTable.rows = [linkRow({ id: "link-a" })];

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
    });

    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
  });

  it("B: does NOT clear a mirror belonging to a different user than the one disconnected", async () => {
    // client's stale mirror points at USER_OTHER, but the link being
    // disconnected belongs to USER_A -- the mirror must be left alone,
    // since it does not belong to the identity actually being disconnected.
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_OTHER })];
    linksTable.rows = [linkRow({ id: "link-a", user_id: USER_A })];

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
    });

    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(clientsTable.rows[0].portal_user_id).toBe(USER_OTHER);
  });

  it("C: exact tuple isolation -- disconnecting Studio A does not touch another client, another studio's relationship, or another user's linked relationship", async () => {
    clientsTable.rows = [
      clientRow({ id: CLIENT_A, studio_id: STUDIO_A, portal_user_id: USER_A }),
      clientRow({ id: CLIENT_B, studio_id: STUDIO_B, portal_user_id: USER_OTHER }),
    ];
    linksTable.rows = [
      linkRow({ id: "link-a", studio_id: STUDIO_A, client_id: CLIENT_A, user_id: USER_A }),
      linkRow({ id: "link-b", studio_id: STUDIO_B, client_id: CLIENT_B, user_id: USER_OTHER }),
    ];

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
    });

    // Studio A relationship disconnected, its own mirror cleared.
    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(clientsTable.rows[0].portal_user_id).toBeNull();

    // Studio B's unrelated client, relationship, and user are untouched.
    expect(linksTable.rows[1].status).toBe("linked");
    expect(clientsTable.rows[1].portal_user_id).toBe(USER_OTHER);
  });

  it("formerClient=true also clears the mirror in addition to the existing client status transition", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_A, status: "active" })];
    linksTable.rows = [linkRow({ id: "link-a" })];

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
      formerClient: true,
    });

    expect(linksTable.rows[0].status).toBe("former_client");
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
    expect(clientsTable.rows[0].status).toBe("inactive");
  });

  it("D: no client is left with a stale portal_user_id after a normal disconnect -- the T-h2b2-stale-mirror invariant now holds for the live write path", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_A })];
    linksTable.rows = [linkRow({ id: "link-a" })];

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
    });

    const staleMirrors = clientsTable.rows.filter((c) => {
      if (c.portal_user_id == null) return false;
      const hasLinkedRow = linksTable.rows.some(
        (l) =>
          l.client_id === c.id &&
          l.studio_id === c.studio_id &&
          l.user_id === c.portal_user_id &&
          l.status === "linked",
      );
      return !hasLinkedRow;
    });

    expect(staleMirrors).toHaveLength(0);
  });
});

describe("leaveStudioRelationship -- H2-B3 stale-mirror cleanup", () => {
  const fakeUser = (id: string) => ({ id }) as { id: string };

  it("clears clients.portal_user_id when it matches the user who just left", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_A })];
    linksTable.rows = [linkRow({ id: "link-a" })];

    await leaveStudioRelationship({
      user: fakeUser(USER_A) as never,
      linkId: "link-a",
      studioId: STUDIO_A,
    });

    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
  });

  it("does NOT clear a mirror belonging to a different user", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_OTHER })];
    linksTable.rows = [linkRow({ id: "link-a", user_id: USER_A })];

    await leaveStudioRelationship({
      user: fakeUser(USER_A) as never,
      linkId: "link-a",
      studioId: STUDIO_A,
    });

    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(clientsTable.rows[0].portal_user_id).toBe(USER_OTHER);
  });
});

describe("deleteDanceFlowAccount -- H2-B3 stale-mirror cleanup", () => {
  const fakeUser = (id: string) => ({ id, email: `${id}@example.test` }) as never;

  it("clears the mirror for the deleted user's own client, but not an unrelated client with a different mirror", async () => {
    clientsTable.rows = [
      clientRow({ id: CLIENT_A, studio_id: STUDIO_A, portal_user_id: USER_A }),
      clientRow({ id: CLIENT_B, studio_id: STUDIO_B, portal_user_id: USER_OTHER }),
    ];
    linksTable.rows = [linkRow({ id: "link-a", studio_id: STUDIO_A, client_id: CLIENT_A, user_id: USER_A })];

    const result = await deleteDanceFlowAccount(fakeUser(USER_A));

    expect(result.deleted).toBe(true);
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
    expect(clientsTable.rows[1].portal_user_id).toBe(USER_OTHER);
    expect(deleteUserCalls).toEqual([USER_A]);
  });

  it("does nothing to any client mirror when the deleted user has no client_account_links rows", async () => {
    clientsTable.rows = [clientRow({ id: CLIENT_B, studio_id: STUDIO_B, portal_user_id: USER_OTHER })];
    linksTable.rows = [];

    await deleteDanceFlowAccount(fakeUser(USER_A));

    expect(clientsTable.rows[0].portal_user_id).toBe(USER_OTHER);
  });
});
