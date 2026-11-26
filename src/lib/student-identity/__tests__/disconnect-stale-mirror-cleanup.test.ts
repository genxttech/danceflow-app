import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";
import { FakeStorage } from "./helpers/fakeStorage";

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
// account ids are UUIDs: the file purge refuses anything else
const USER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const USER_OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
let storage: FakeStorage;

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
let userStudioRolesTable: FakeTable;
let organizerUsersTable: FakeTable;
let deleteUserCalls: string[];
let deleteUserError: { message: string } | null = null;
let onDeleteUser: (() => void) | null = null;
let loginGone = false;
/** A table whose reads answer with an error, to drive the role check's failure branch. */
let failingTable: string | null = null;

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
      if (table === failingTable) {
        const failed = {
          select: () => failed,
          eq: () => failed,
          limit: () => failed,
          update: () => failed,
          then: (onFulfilled: (v: { data: null; error: { message: string } }) => unknown) => Promise.resolve({ data: null, error: { message: `${table} unavailable` } }).then(onFulfilled),
        };
        return failed;
      }
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
      get user_studio_roles() {
        return userStudioRolesTable;
      },
      get organizer_users() {
        return organizerUsersTable;
      },
    } as unknown as Record<string, FakeTable>),
    storage,
    auth: {
      admin: {
        getUserById: async (id: string) =>
          loginGone ? { data: { user: null }, error: { status: 404, code: "user_not_found", message: "User not found" } } : { data: { user: { id } }, error: null },
        deleteUser: async (userId: string) => {
          deleteUserCalls.push(userId);
          onDeleteUser?.();
          return { error: deleteUserError };
        },
      },
    },
  }),
}));

// the two entry points (the app's route and the web account action), driven through the real deletion code
let signedInUser: { id: string; email: string } | null = null;
vi.mock("@/lib/auth/studentApiAuth", () => ({
  getStudentApiUser: async () => signedInUser,
  studentApiJsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedInUser } }) } }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { DELETE: deleteRoute } = await import("@/app/api/student/account/route");
const { deleteAccountAction } = await import("@/app/account/actions");
const { disconnectClientAccount } = await import("@/lib/student-identity/lifecycle");
const { leaveStudioRelationship, deleteDanceFlowAccount, AccountDeletionBlockedError } = await import(
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
  userStudioRolesTable = new FakeTable();
  organizerUsersTable = new FakeTable();
  deleteUserCalls = [];
  failingTable = null;
  storage = new FakeStorage();
  deleteUserError = null;
  onDeleteUser = null;
  loginGone = false;
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

describe("disconnectClientAccount -- H2-C2 relationship-scoped unlink", () => {
  // A client can have more than one simultaneous linked client_account_links
  // row (e.g. a self relationship for the dancer and a guardian relationship
  // for a parent). disconnectClientAccount's userId param, when supplied,
  // scopes the UPDATE to exactly one row -- guaranteed by the
  // client_account_links_client_user_unique partial unique index on
  // (client_id, user_id), which means a client can never have two rows with
  // the same non-null user_id. These tests prove that scoping, which the
  // H2-B3 suite above never exercised (every one of its fixtures uses a
  // single client_account_links row per client).
  const USER_B = "user-b";

  function twoRelationshipFixture() {
    clientsTable.rows = [clientRow({ id: CLIENT_A, portal_user_id: USER_A })];
    linksTable.rows = [
      linkRow({ id: "link-self", user_id: USER_A, relationship_type: "self", is_primary: true }),
      linkRow({ id: "link-guardian", user_id: USER_B, relationship_type: "guardian", is_primary: false }),
    ];
  }

  it("1: disconnecting by userId targets only that relationship's row, leaving the sibling relationship linked", async () => {
    twoRelationshipFixture();

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
      userId: USER_A,
    });

    expect(linksTable.rows[0].status).toBe("disconnected"); // link-self
    expect(linksTable.rows[1].status).toBe("linked"); // link-guardian, untouched
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
  });

  it("2: disconnecting the other relationship's userId is the mirror image -- only that row moves, the other stays linked", async () => {
    twoRelationshipFixture();

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
      userId: USER_B,
    });

    expect(linksTable.rows[0].status).toBe("linked"); // link-self, untouched
    expect(linksTable.rows[1].status).toBe("disconnected"); // link-guardian
    // The client's stale mirror belongs to USER_A, not the user just
    // disconnected (USER_B) -- H2-B3's exact-user-match guard correctly
    // leaves it alone.
    expect(clientsTable.rows[0].portal_user_id).toBe(USER_A);
  });

  it("3: formerClient=true with multiple linked rows still scopes the row-level status transition to the targeted userId, while the client-level inactive transition applies once for the whole client", async () => {
    twoRelationshipFixture();

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
      formerClient: true,
      userId: USER_B,
    });

    expect(linksTable.rows[0].status).toBe("linked"); // link-self, untouched
    expect(linksTable.rows[1].status).toBe("former_client"); // link-guardian
    expect(clientsTable.rows[0].status).toBe("inactive"); // client-level, unaffected by row-scoping
  });

  it("4: regression guard -- omitting userId is unchanged, still disconnects every linked row for the client (this is disconnectClientAccount's own documented contract; H2-C2 fixed its callers, not this function)", async () => {
    twoRelationshipFixture();

    await disconnectClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      disconnectedBy: "staff-1",
      reason: "test",
    });

    expect(linksTable.rows[0].status).toBe("disconnected");
    expect(linksTable.rows[1].status).toBe("disconnected");
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

describe("deleteDanceFlowAccount -- logins that also manage something", () => {
  const fakeUser = (id: string) => ({ id, email: `${id}@example.test` }) as never;

  // A login with an active management role is refused before any write.
  it.each([
    ["an active studio role", () => { userStudioRolesTable.rows = [{ id: "r1", user_id: USER_A, studio_id: STUDIO_A, role: "studio_owner", active: true }]; }, "studio_role"],
    ["an active organizer role", () => { organizerUsersTable.rows = [{ id: "o1", user_id: USER_A, active: true }]; }, "organizer_role"],
    ["platform admin", () => { profilesTable.rows = [{ id: USER_A, platform_role: "platform_admin" }]; }, "platform_admin"],
  ])("refuses a login with %s and changes nothing", async (_label, seed, reason) => {
    seed();
    linksTable.rows = [linkRow({ id: "link-a" })];

    const error = await deleteDanceFlowAccount(fakeUser(USER_A)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AccountDeletionBlockedError);
    expect((error as InstanceType<typeof AccountDeletionBlockedError>).reasons).toEqual([reason]);
    expect(deleteUserCalls).toEqual([]);
    expect(userAccountStatusTable.rows).toEqual([]);
    expect(linksTable.rows[0].status).toBe("linked");
    expect(accountDeletionAuditTable.rows).toEqual([]);
  });

  it("still deletes a login whose studio and organizer roles are all inactive", async () => {
    userStudioRolesTable.rows = [{ id: "r1", user_id: USER_A, studio_id: STUDIO_A, role: "instructor", active: false }];
    organizerUsersTable.rows = [{ id: "o1", user_id: USER_A, active: false }];
    profilesTable.rows = [{ id: USER_A, platform_role: null }];

    await deleteDanceFlowAccount(fakeUser(USER_A));

    expect(deleteUserCalls).toEqual([USER_A]);
  });
});

describe("account deletion through the app route and the web action", () => {
  const owner = () => { userStudioRolesTable.rows = [{ id: "r1", user_id: USER_A, studio_id: STUDIO_A, role: "studio_owner", active: true }]; };
  const signIn = () => { signedInUser = { id: USER_A, email: `${USER_A}@example.test` }; };
  const request = () => new Request("https://app.test/api/student/account", { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) });
  const confirmed = () => { const form = new FormData(); form.set("confirmation", "DELETE"); return form; };

  it.each(["user_studio_roles", "organizer_users", "profiles"])("fails closed when the %s role query errors: nothing is deleted or changed, through the library, the app route and the web action", async (table) => {
    signIn();
    linksTable.rows = [linkRow({ id: "link-a" })];
    failingTable = table;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteDanceFlowAccount(signedInUser as never)).rejects.toThrow(`Account role check failed: ${table} unavailable`);
    const response = await deleteRoute(request());
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe("Your DanceFlow account could not be deleted.");
    await expect(deleteAccountAction(confirmed())).rejects.toThrow("redirect:/account?error=account_delete_failed");

    expect(deleteUserCalls).toEqual([]);
    expect(userAccountStatusTable.rows).toEqual([]);
    expect(linksTable.rows[0].status).toBe("linked");
    expect(accountDeletionAuditTable.rows).toEqual([]);
  });

  it("an ordinary account with no management role deletes itself", async () => {
    signIn();
    const response = await deleteRoute(request());
    expect(response.status).toBe(200);
    expect(deleteUserCalls).toEqual([USER_A]);
  });

  it("a studio owner is refused by the app route with 409 and a reason, and nothing is deleted", async () => {
    signIn();
    owner();
    const response = await deleteRoute(request());
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/can't be deleted here/);
    expect(deleteUserCalls).toEqual([]);
    expect(accountDeletionAuditTable.rows).toEqual([]);
  });

  it("the web account action sends a studio owner back with the reason, and an ordinary account is deleted", async () => {
    signIn();
    owner();
    await expect(deleteAccountAction(confirmed())).rejects.toThrow("redirect:/account?error=account_delete_managed_access");
    expect(deleteUserCalls).toEqual([]);

    userStudioRolesTable.rows = [];
    await expect(deleteAccountAction(confirmed())).rejects.toThrow("redirect:/?account=deleted");
    expect(deleteUserCalls).toEqual([USER_A]);
  });
});

describe("deleteDanceFlowAccount -- the account's own photos", () => {
  const user = () => ({ id: USER_A, email: "a@example.test" }) as never;
  const own = `${USER_A}/profile-1.jpg`;
  const theirs = `${USER_OTHER}/profile-2.jpg`;
  const seed = () => {
    storage.files.add(own);
    storage.files.add(theirs);
    // the listing points at someone else's photo: a stored URL must never decide what is removed
    dancerPartnerProfilesTable.rows = [
      { id: "pp-a", user_id: USER_A, visibility: "published", photo_url: `https://x.test/storage/v1/object/public/partner-profile-photos/${theirs}` },
      { id: "pp-o", user_id: USER_OTHER, visibility: "published", photo_url: null },
    ];
    linksTable.rows = [linkRow({ id: "link-a", user_id: USER_A })];
  };

  it("removes the owner's files and nobody else's, and deletes the account", async () => {
    seed();
    await deleteDanceFlowAccount(user());
    expect([...storage.files]).toEqual([theirs]);
    expect(deleteUserCalls).toEqual([USER_A]);
    expect(dancerPartnerProfilesTable.rows.map((row) => row.user_id)).toEqual([USER_OTHER]);
  });

  it("stops before the account is marked for deletion when the files cannot be removed: account kept, listing hidden, retry works", async () => {
    seed();
    storage.failRemoveCall = 1;

    await expect(deleteDanceFlowAccount(user())).rejects.toThrow("Account files could not be removed (remove_failed).");

    expect(deleteUserCalls).toEqual([]);
    expect(userAccountStatusTable.rows).toEqual([]);
    expect(linksTable.rows[0].status).toBe("linked");
    expect(accountDeletionAuditTable.rows).toEqual([]);
    expect(dancerPartnerProfilesTable.rows.map((row) => row.visibility)).toEqual(["archived", "published"]);

    await deleteDanceFlowAccount(user());
    expect(deleteUserCalls).toEqual([USER_A]);
    expect([...storage.files]).toEqual([theirs]);
  });

  it("changes no file and marks nothing when the listing cannot be hidden first", async () => {
    seed();
    failingTable = "dancer_partner_profiles";
    await expect(deleteDanceFlowAccount(user())).rejects.toThrow("Partner listing cleanup failed: dancer_partner_profiles unavailable");
    expect(storage.removeCalls).toEqual([]);
    expect(userAccountStatusTable.rows).toEqual([]);
    expect(deleteUserCalls).toEqual([]);
  });

  it("removes a file added while the deletion ran (second pass)", async () => {
    seed();
    const late = `${USER_A}/late.jpg`;
    onDeleteUser = () => storage.files.add(late);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await deleteDanceFlowAccount(user());

    expect([...storage.files]).toEqual([theirs]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(USER_A);
  });

  it("a failing second pass still reports the account deleted and records a follow-up without ids or file names", async () => {
    seed();
    const late = `${USER_A}/late.jpg`;
    onDeleteUser = () => {
      storage.files.add(late);
      storage.failList = true;
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteDanceFlowAccount(user())).resolves.toMatchObject({ deleted: true });

    expect(error).toHaveBeenCalledWith("Account deletion: second file pass failed, follow up needed", expect.objectContaining({ code: "list_failed" }));
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(USER_A);
    expect(logged).not.toContain("late.jpg");
  });

  it("does not run the second pass when the login could not be removed, and the half-deleted account can be deleted again", async () => {
    seed();
    clientsTable.rows = [clientRow({ id: CLIENT_A, studio_id: STUDIO_A, portal_user_id: USER_A })];
    deleteUserError = { message: "auth unavailable" };
    await expect(deleteDanceFlowAccount(user())).rejects.toThrow("auth unavailable");
    expect(userAccountStatusTable.rows).toEqual([expect.objectContaining({ user_id: USER_A, status: "pending_deletion" })]);

    // the retry finds no relationship rows any more; a mirror an interrupted attempt left behind is still cleared
    clientsTable.rows[0].portal_user_id = USER_A;
    deleteUserError = null;
    await expect(deleteDanceFlowAccount(user())).resolves.toMatchObject({ deleted: true });
    expect(deleteUserCalls).toEqual([USER_A, USER_A]);
    expect(clientsTable.rows[0].portal_user_id).toBeNull();
    expect([...storage.files]).toEqual([theirs]);
  });

  it("reports the deletion done when another request already removed the login", async () => {
    seed();
    deleteUserError = { message: "User not found" };
    onDeleteUser = () => {
      loginGone = true;
    };
    await expect(deleteDanceFlowAccount(user())).resolves.toMatchObject({ deleted: true });
    expect([...storage.files]).toEqual([theirs]);
  });

  it("two requests at once both finish, and only the owner's files go", async () => {
    seed();
    const results = await Promise.allSettled([deleteDanceFlowAccount(user()), deleteDanceFlowAccount(user())]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect([...storage.files]).toEqual([theirs]);
    expect(dancerPartnerProfilesTable.rows.map((row) => row.user_id)).toEqual([USER_OTHER]);
  });
});
