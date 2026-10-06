import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * GC-3.4B-0: identity-linking security prerequisite.
 *
 *  S1 -- a conflict row carrying a mismatched account is never promoted to an
 *        authorized link by staff conflict resolution; the verified matching
 *        account gets the relationship type staff originally issued.
 *  S2 -- a verified-email mismatch on invite accept/reject writes nothing.
 *  S3 -- accept/reject require the canonical verified email; user.email is
 *        not identity evidence (the functions no longer accept it at all).
 *
 * The in-memory fake has no database constraints, so every scenario also
 * checks the client_account_links unique-index invariants explicitly.
 */

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const OWNER = "user-owner";
const INTRUDER = "user-intruder";
const OWNER_EMAIL = "parent@example.com";
const INTRUDER_EMAIL = "intruder@example.com";
const TOKEN = "invite-token-abc";

let clientsTable: FakeTable;
let linksTable: FakeTable;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    createFakeEntitlementClient({
      get clients() {
        return clientsTable;
      },
      get client_account_links() {
        return linksTable;
      },
    }),
}));

const {
  acceptClientInvitation,
  rejectClientInvitation,
  resolveClientAccountConflict,
  clientInvitationIdentity,
  linkExistingClientAccount,
} = await import("../lifecycle");

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function invitationRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "invite-1",
    studio_id: STUDIO_A,
    client_id: CLIENT_A,
    user_id: null,
    status: "invited",
    relationship_type: "guardian",
    is_primary: false,
    can_manage_bookings: true,
    invited_email: OWNER_EMAIL,
    invite_token_hash: hash(TOKEN),
    invite_expires_at: "2099-01-01T00:00:00Z",
    conflict_details: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    studios: { name: "Studio A", public_name: "Studio A", slug: "studio-a" },
    clients: { first_name: "Kid", last_name: "Dancer" },
    ...overrides,
  };
}

function snapshot() {
  return JSON.parse(JSON.stringify(linksTable.rows));
}

function linkedRowsFor(userId: string) {
  return linksTable.rows.filter((row) => row.user_id === userId && row.status === "linked");
}

/** The client_account_links unique indexes the real database enforces. */
function expectLinkInvariants() {
  const rows = linksTable.rows;
  const pairs = rows.filter((r) => r.user_id).map((r) => `${r.client_id}|${r.user_id}`);
  expect(new Set(pairs).size).toBe(pairs.length);
  const linkedSelf = rows.filter((r) => r.status === "linked" && r.relationship_type === "self").map((r) => r.client_id);
  expect(new Set(linkedSelf).size).toBe(linkedSelf.length);
  const primaries = rows.filter((r) => r.status === "linked" && r.is_primary === true).map((r) => `${r.user_id}|${r.studio_id}`);
  expect(new Set(primaries).size).toBe(primaries.length);
}

beforeEach(() => {
  clientsTable = new FakeTable();
  linksTable = new FakeTable();
  clientsTable.rows = [
    { id: CLIENT_A, studio_id: STUDIO_A },
    { id: CLIENT_B, studio_id: STUDIO_B },
  ];
});

describe("clientInvitationIdentity (GC-3.4B-0 S3)", () => {
  it("requires a verified email; a mismatch or missing invited email is refused", () => {
    expect(clientInvitationIdentity(OWNER_EMAIL, null)).toBe("verification_required");
    expect(clientInvitationIdentity(OWNER_EMAIL, "")).toBe("verification_required");
    expect(clientInvitationIdentity(OWNER_EMAIL, INTRUDER_EMAIL)).toBe("mismatch");
    expect(clientInvitationIdentity(null, OWNER_EMAIL)).toBe("mismatch");
    expect(clientInvitationIdentity(" Parent@Example.com ", "parent@example.com")).toBe("verified_match");
  });
});

describe("acceptClientInvitation: mismatch and unverified callers write nothing (S2/S3)", () => {
  it("a verified different email is refused with no write at all", async () => {
    linksTable.rows = [invitationRow()];
    const before = snapshot();

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");

    expect(snapshot()).toEqual(before);
    expect(linksTable.rows[0].user_id).toBeNull();
    expect(linksTable.rows[0].status).toBe("invited");
    expect(linksTable.rows[0].invite_token_hash).toBe(hash(TOKEN));
  });

  it("an unverified session whose user.email equals the invited email is still refused (no write)", async () => {
    // The function cannot be handed user.email: only the session's verified
    // email counts, and an unverified session has none.
    linksTable.rows = [invitationRow()];
    const before = snapshot();

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: null }),
    ).rejects.toThrow("invite_verification_required");

    expect(snapshot()).toEqual(before);
  });

  it("a mismatched caller on an expired invitation is refused before the expiry write", async () => {
    linksTable.rows = [invitationRow({ invite_expires_at: "2020-01-01T00:00:00Z" })];
    const before = snapshot();

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");

    expect(snapshot()).toEqual(before);
  });

  it("a mismatched caller cannot learn a handled invitation's status", async () => {
    linksTable.rows = [invitationRow({ status: "linked", user_id: OWNER })];

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");
  });

  it("rejectClientInvitation applies the same rule (mismatch and unverified write nothing)", async () => {
    linksTable.rows = [invitationRow()];
    const before = snapshot();

    await expect(
      rejectClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");
    await expect(
      rejectClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: null }),
    ).rejects.toThrow("invite_verification_required");

    expect(snapshot()).toEqual(before);
  });

  it("an invitation with no invited email can never be accepted or rejected", async () => {
    linksTable.rows = [invitationRow({ invited_email: null })];
    const before = snapshot();

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");
    await expect(
      rejectClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");

    expect(snapshot()).toEqual(before);
  });
});

describe("acceptClientInvitation: the verified invitee is linked with the staff-issued type", () => {
  it.each(["self", "guardian", "parent", "billing_contact", "dependent_manager", "dependent"])(
    "%s invitation links the verified invitee with that relationship type",
    async (relationshipType) => {
      linksTable.rows = [invitationRow({ relationship_type: relationshipType })];

      const result = await acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL });

      expect(result.clientId).toBe(CLIENT_A);
      const linked = linkedRowsFor(OWNER);
      expect(linked).toHaveLength(1);
      expect(linked[0]).toMatchObject({
        studio_id: STUDIO_A,
        client_id: CLIENT_A,
        relationship_type: relationshipType,
        can_manage_bookings: true,
        is_primary: relationshipType === "self",
      });
      // Single use: the token no longer resolves.
      expect(linksTable.rows.every((row) => row.invite_token_hash !== hash(TOKEN))).toBe(true);
      expectLinkInvariants();
    },
  );

  it("double accept (two tabs / retry) stays one link; the second attempt finds no open token", async () => {
    linksTable.rows = [invitationRow()];

    await acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL });
    await expect(
      acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL }),
    ).rejects.toThrow("invite_not_found");

    expect(linkedRowsFor(OWNER)).toHaveLength(1);
    expectLinkInvariants();
  });

  it("an already-linked invitation (claimed at login, token still present) is idempotent for the verified invitee", async () => {
    linksTable.rows = [invitationRow({ status: "linked", user_id: OWNER })];
    const before = snapshot();

    const result = await acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL });

    expect(result.status).toBe("linked");
    expect(snapshot()).toEqual(before);
  });
});

/*
  S1 scenario. Before GC-3.4B-0, a token holder signed in with a different
  account turned the invitation into 'conflict' carrying THEIR user_id; staff
  "Link Matching Email Account" then linked the real account and also flipped
  that conflict row to 'linked' without changing its user_id. The fixtures
  below reproduce rows that pre-fix code (or a pre-fix deployment) left behind.
*/
function legacyMismatchConflict(relationshipType: string, overrides: Partial<Row> = {}): Row {
  return invitationRow({
    status: "conflict",
    user_id: INTRUDER,
    relationship_type: relationshipType,
    is_primary: relationshipType === "self",
    conflict_details: "The signed-in DanceFlow account email does not match the invited email.",
    ...overrides,
  });
}

describe("resolveClientAccountConflict never authorizes a mismatched account (S1, P1)", () => {
  it.each(["guardian", "parent", "billing_contact", "dependent_manager", "dependent"])(
    "%s conflict: only the matching account is linked, with the original type; the intruder gains nothing",
    async (relationshipType) => {
      linksTable.rows = [legacyMismatchConflict(relationshipType)];

      await resolveClientAccountConflict({
        studioId: STUDIO_A,
        clientId: CLIENT_A,
        resolution: "link_matching_account",
        matchingUserId: OWNER,
        invitedEmail: OWNER_EMAIL,
      });

      expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
      expect(
        linksTable.rows.some(
          (row) => row.user_id === INTRUDER && row.status === "linked" && row.can_manage_bookings === true,
        ),
      ).toBe(false);

      const owner = linkedRowsFor(OWNER);
      expect(owner).toHaveLength(1);
      expect(owner[0]).toMatchObject({
        studio_id: STUDIO_A,
        client_id: CLIENT_A,
        relationship_type: relationshipType,
        can_manage_bookings: true,
      });

      const superseded = linksTable.rows.find((row) => row.id === "invite-1")!;
      expect(superseded.status).toBe("disconnected");
      expect(superseded.invite_token_hash).toBeNull();
      expect(superseded.invite_expires_at).toBeNull();
      expect(linksTable.rows.some((row) => row.status === "conflict")).toBe(false);
      expectLinkInvariants();
    },
  );

  it("self conflict: the matching account is linked as self and the intruder row is not", async () => {
    linksTable.rows = [legacyMismatchConflict("self")];

    await resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "link_matching_account",
      matchingUserId: OWNER,
      invitedEmail: OWNER_EMAIL,
    });

    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
    expect(linkedRowsFor(OWNER)).toEqual([
      expect.objectContaining({ relationship_type: "self", is_primary: true }),
    ]);
    expectLinkInvariants();
  });

  it("several stale conflict rows (repeated mismatched attempts) are all superseded", async () => {
    linksTable.rows = [
      legacyMismatchConflict("guardian"),
      legacyMismatchConflict("guardian", {
        id: "invite-0",
        user_id: "user-intruder-2",
        updated_at: "2026-09-01T00:00:00Z",
      }),
    ];

    await resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "link_matching_account",
      matchingUserId: OWNER,
      invitedEmail: OWNER_EMAIL,
    });

    expect(linksTable.rows.filter((row) => row.status === "linked").map((row) => row.user_id)).toEqual([OWNER]);
    expect(linksTable.rows.some((row) => row.status === "conflict")).toBe(false);
  });

  it("a claim-RPC conflict row with no user is relinked to the matching account only", async () => {
    linksTable.rows = [legacyMismatchConflict("parent", { user_id: null })];

    await resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "link_matching_account",
      matchingUserId: OWNER,
      invitedEmail: OWNER_EMAIL,
    });

    expect(linksTable.rows.filter((row) => row.status === "linked")).toEqual([
      expect.objectContaining({ id: "invite-1", user_id: OWNER, relationship_type: "parent" }),
    ]);
    expectLinkInvariants();
  });

  it("a conflict row already owned by the matching account is relinked in place (no duplicate)", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian", { user_id: OWNER })];

    await resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "link_matching_account",
      matchingUserId: OWNER,
      invitedEmail: OWNER_EMAIL,
    });

    expect(linksTable.rows).toHaveLength(1);
    expect(linksTable.rows[0]).toMatchObject({ status: "linked", user_id: OWNER, relationship_type: "guardian" });
    expectLinkInvariants();
  });

  it("without a matching account nothing is linked", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian")];
    const before = snapshot();

    await expect(
      resolveClientAccountConflict({
        studioId: STUDIO_A,
        clientId: CLIENT_A,
        resolution: "link_matching_account",
        matchingUserId: null,
        invitedEmail: OWNER_EMAIL,
      }),
    ).rejects.toThrow();

    expect(snapshot()).toEqual(before);
  });

  it("dismiss leaves the intruder unlinked", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian")];

    await resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "dismiss_conflict",
      invitedEmail: OWNER_EMAIL,
    });

    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
    expect(linksTable.rows[0].status).toBe("disconnected");
  });

  it("end to end: a mismatched accept no longer creates a conflict, so there is nothing to promote", async () => {
    linksTable.rows = [invitationRow({ relationship_type: "guardian" })];

    await expect(
      acceptClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
    ).rejects.toThrow("invite_email_mismatch");
    await expect(
      resolveClientAccountConflict({
        studioId: STUDIO_A,
        clientId: CLIENT_A,
        resolution: "link_matching_account",
        matchingUserId: OWNER,
        invitedEmail: OWNER_EMAIL,
      }),
    ).rejects.toThrow("No unresolved account conflict was found.");

    // The legitimate recipient can still accept the untouched invitation.
    await acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL });
    expect(linkedRowsFor(OWNER)).toEqual([expect.objectContaining({ relationship_type: "guardian" })]);
    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
  });
});

describe("cross-studio scoping is unchanged", () => {
  it("resolving in another studio never touches this studio's conflict rows", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian")];
    const before = snapshot();

    await expect(
      resolveClientAccountConflict({
        studioId: STUDIO_B,
        clientId: CLIENT_A,
        resolution: "link_matching_account",
        matchingUserId: OWNER,
        invitedEmail: OWNER_EMAIL,
      }),
    ).rejects.toThrow("No unresolved account conflict was found.");

    expect(snapshot()).toEqual(before);
  });

  it("a conflict whose client is not in the resolving studio cannot be linked", async () => {
    // A substituted client id from another studio fails the client/studio pin.
    linksTable.rows = [legacyMismatchConflict("guardian", { studio_id: STUDIO_B, client_id: CLIENT_A })];

    await expect(
      resolveClientAccountConflict({
        studioId: STUDIO_B,
        clientId: CLIENT_A,
        resolution: "link_matching_account",
        matchingUserId: OWNER,
        invitedEmail: OWNER_EMAIL,
      }),
    ).rejects.toThrow("Client record could not be found.");

    expect(linkedRowsFor(OWNER)).toHaveLength(0);
    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
  });

  it("an invitation is linked only to its own studio and client", async () => {
    linksTable.rows = [invitationRow({ studio_id: STUDIO_B, client_id: CLIENT_B })];

    await acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: OWNER_EMAIL });

    expect(linkedRowsFor(OWNER)).toEqual([
      expect.objectContaining({ studio_id: STUDIO_B, client_id: CLIENT_B }),
    ]);
  });
});

/*
  GC-3.4B-0 focused review: the supersede step must be narrow. Only conflict
  rows for the same intent (same invited email and relationship type) are
  superseded; distinct staff-issued relationships, open invitations, linked
  relationships and other studios survive.
*/
describe("resolveClientAccountConflict cleanup scope (focused review)", () => {
  const OTHER_PARENT_EMAIL = "other-parent@example.com";
  const resolve = () =>
    resolveClientAccountConflict({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      resolution: "link_matching_account",
      matchingUserId: OWNER,
      invitedEmail: OWNER_EMAIL,
    });

  it("A: a mismatched guardian conflict is resolved while a legitimate open self invitation is untouched", async () => {
    const openSelf = invitationRow({
      id: "invite-self",
      relationship_type: "self",
      is_primary: true,
      invited_email: "kid@example.com",
      invite_token_hash: hash("self-token"),
    });
    linksTable.rows = [legacyMismatchConflict("guardian", { invite_token_hash: hash("old") }), openSelf];
    const openBefore = { ...openSelf };

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "invite-self")).toEqual(openBefore);
    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
    expect(linkedRowsFor(OWNER)).toEqual([expect.objectContaining({ relationship_type: "guardian" })]);
    expectLinkInvariants();
  });

  it("B/G: a conflict issued to a different email (another parent) is left for separate review", async () => {
    linksTable.rows = [
      legacyMismatchConflict("guardian"),
      legacyMismatchConflict("guardian", {
        id: "other-parent-conflict",
        user_id: null,
        invited_email: OTHER_PARENT_EMAIL,
        invite_token_hash: hash("other"),
        updated_at: "2026-10-02T00:00:00Z",
      }),
    ];
    const otherBefore = { ...linksTable.rows[1] };

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "other-parent-conflict")).toEqual(otherBefore);
    expect(linksTable.rows.find((row) => row.id === "invite-1")!.status).toBe("disconnected");
  });

  it("refuses with no write when the only conflict was issued to a different email", async () => {
    // Previously the client-email account would have been linked with the
    // other email's relationship type.
    linksTable.rows = [legacyMismatchConflict("guardian", { invited_email: OTHER_PARENT_EMAIL })];
    const before = snapshot();

    await expect(resolve()).rejects.toThrow("No unresolved account conflict was found for this client's email.");
    expect(snapshot()).toEqual(before);
  });

  it("refuses with no write when the conflict has no invited email", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian", { invited_email: null })];
    const before = snapshot();

    await expect(resolve()).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("a same-email conflict of a different relationship type is not superseded", async () => {
    linksTable.rows = [
      legacyMismatchConflict("guardian"),
      legacyMismatchConflict("billing_contact", {
        id: "billing-conflict",
        user_id: "user-intruder-2",
        updated_at: "2026-09-01T00:00:00Z",
      }),
    ];

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "billing-conflict")!.status).toBe("conflict");
    expect(linkedRowsFor("user-intruder-2")).toHaveLength(0);
  });

  it("D: two conflicts for different accounts, one the matching account: relinked in place, the other superseded", async () => {
    linksTable.rows = [
      legacyMismatchConflict("guardian", { id: "owner-conflict", user_id: OWNER, invite_token_hash: null }),
      legacyMismatchConflict("guardian", { updated_at: "2026-10-03T00:00:00Z" }),
    ];

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "owner-conflict")).toMatchObject({ status: "linked", user_id: OWNER });
    expect(linksTable.rows.find((row) => row.id === "invite-1")).toMatchObject({ status: "disconnected", user_id: INTRUDER });
    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
    expectLinkInvariants();
  });

  it("E: existing legitimate linked relationships survive (another guardian and the owner's own link)", async () => {
    const secondParent = invitationRow({
      id: "second-parent",
      status: "linked",
      user_id: "user-second-parent",
      invited_email: OTHER_PARENT_EMAIL,
      invite_token_hash: null,
    });
    linksTable.rows = [legacyMismatchConflict("guardian"), secondParent];
    const secondBefore = { ...secondParent };

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "second-parent")).toEqual(secondBefore);
    expect(linkedRowsFor(OWNER)).toHaveLength(1);
    expect(linkedRowsFor(INTRUDER)).toHaveLength(0);
  });

  it("F: a repeated staff click writes nothing more", async () => {
    linksTable.rows = [legacyMismatchConflict("guardian")];
    await resolve();
    const after = snapshot();

    await expect(resolve()).rejects.toThrow("No unresolved account conflict was found");
    expect(snapshot()).toEqual(after);
  });

  it("H: same-email conflict rows in another studio are untouched", async () => {
    const foreign = legacyMismatchConflict("guardian", {
      id: "studio-b-conflict",
      studio_id: STUDIO_B,
      client_id: CLIENT_B,
      invite_token_hash: hash("b"),
    });
    linksTable.rows = [legacyMismatchConflict("guardian"), foreign];
    const foreignBefore = { ...foreign };

    await resolve();

    expect(linksTable.rows.find((row) => row.id === "studio-b-conflict")).toEqual(foreignBefore);
  });
});

describe("linkExistingClientAccount never takes over another email's invitation (focused review)", () => {
  it("staff direct link of parent A as guardian leaves parent B's open guardian invitation intact", async () => {
    const parentB = invitationRow({ id: "parent-b-invite", invited_email: "parent-b@example.com" });
    linksTable.rows = [parentB];
    const before = { ...parentB };

    await linkExistingClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      userId: OWNER,
      invitedEmail: OWNER_EMAIL,
      relationshipType: "guardian",
    });

    expect(linksTable.rows.find((row) => row.id === "parent-b-invite")).toEqual(before);
    expect(linkedRowsFor(OWNER)).toEqual([
      expect.objectContaining({ relationship_type: "guardian", invited_email: OWNER_EMAIL }),
    ]);
    expectLinkInvariants();
  });

  it("a same-email open invitation of the same type is reused and its token spent", async () => {
    linksTable.rows = [invitationRow()];

    await linkExistingClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      userId: OWNER,
      invitedEmail: OWNER_EMAIL,
      relationshipType: "guardian",
    });

    expect(linksTable.rows).toHaveLength(1);
    expect(linksTable.rows[0]).toMatchObject({ id: "invite-1", status: "linked", user_id: OWNER, invite_token_hash: null });
  });

  it("linking as self retires any open self invitation (one self account per client)", async () => {
    linksTable.rows = [
      invitationRow({ id: "old-self", relationship_type: "self", is_primary: true, invited_email: "old@example.com" }),
    ];

    await linkExistingClientAccount({
      studioId: STUDIO_A,
      clientId: CLIENT_A,
      userId: OWNER,
      invitedEmail: OWNER_EMAIL,
      relationshipType: "self",
    });

    expect(linksTable.rows.find((row) => row.id === "old-self")).toMatchObject({
      status: "invited",
      invite_token_hash: null,
      user_id: null,
    });
    expectLinkInvariants();
  });
});

describe("mismatch no-write across every relationship type and invitation state (focused review)", () => {
  const TYPES = ["self", "guardian", "parent", "billing_contact", "dependent_manager", "dependent"];
  const STATES: Array<Partial<Row>> = [
    {},
    { invite_expires_at: "2020-01-01T00:00:00Z" },
    { status: "claim_pending" },
    { status: "linked", user_id: OWNER },
    { status: "conflict", user_id: "user-x" },
    { status: "rejected", user_id: "user-x" },
    { status: "disconnected", user_id: "user-x" },
  ];

  it.each(TYPES)("%s: every state gives the same refusal and no field changes", async (relationshipType) => {
    for (const overrides of STATES) {
      linksTable.rows = [invitationRow({ relationship_type: relationshipType, ...overrides })];
      const before = snapshot();

      // Same error for every state: no status oracle for a mismatched account.
      await expect(
        acceptClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
      ).rejects.toThrow("invite_email_mismatch");
      await expect(
        rejectClientInvitation({ token: TOKEN, userId: INTRUDER, verifiedEmail: INTRUDER_EMAIL }),
      ).rejects.toThrow("invite_email_mismatch");
      await expect(
        acceptClientInvitation({ token: TOKEN, userId: OWNER, verifiedEmail: null }),
      ).rejects.toThrow("invite_verification_required");

      expect(snapshot()).toEqual(before);
    }
  });
});
