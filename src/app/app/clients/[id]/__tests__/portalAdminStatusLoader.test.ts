import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientRecord } from "@/app/app/clients/[id]/page";

/**
 * Sallie Debolt portal-status fix: loadClientPortalAdminStatus previously
 * ran client_account_links, outbound_deliveries, profiles, and an
 * auth.users lookup through PostgREST (`adminSupabase.schema("auth")
 * .from("users")`) inside one `Promise.all`, then threw on the FIRST
 * query with a `.error`, discarding every other already-successfully-
 * fetched result. Because `auth` is not an exposed PostgREST schema in
 * this project, the auth-schema query always failed, silently discarding
 * an already-correct `linked` client_account_links row and already-
 * correct outbound_deliveries rows -- producing a false "Not Connected" /
 * "No Invite Recorded" for a genuinely healthy, linked relationship
 * (the exact production state confirmed for Sallie Debolt).
 *
 * This suite proves: (1) client_account_links and outbound_deliveries are
 * load-bearing -- a real failure in either still produces lookupError;
 * (2) every other lookup (linked/matching profile, linked/matching auth
 * user) is best-effort enrichment -- a failure there leaves that one
 * field null without erasing accountLink/inviteDeliveries/lookupError;
 * (3) the auth-user lookup now goes through the Admin Auth API
 * (auth.admin.listUsers, the same paginated-scan pattern already used by
 * findOrCreatePortalProfileByEmail in ../actions.ts), not
 * `schema("auth")` -- proven by a fake admin client that has no
 * `.schema()` method at all, so the whole call would throw immediately
 * if that code path were ever reintroduced.
 */

type Row = Record<string, unknown>;

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const LINKED_USER_ID = "user-linked-1";

function clientAccountLinkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "link-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    user_id: LINKED_USER_ID,
    status: "linked",
    relationship_type: "self",
    is_primary: true,
    created_at: "2026-09-01T16:31:08.000Z",
    invited_email: "sallie@example.test",
    invite_token_hash: null,
    invite_sent_at: null,
    invite_expires_at: null,
    linked_at: "2026-09-01T16:31:08.000Z",
    disconnected_at: null,
    disconnect_reason: null,
    conflict_details: null,
    ...overrides,
  };
}

function deliveryRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "delivery-1",
    template_key: "client_portal_invite",
    recipient_email: "sallie@example.test",
    subject: "DanceFlow portal invite",
    status: "failed",
    provider_message_id: null,
    error_message: "This client already has portal access with that DanceFlow account.",
    sent_at: null,
    created_at: "2026-09-01T15:00:00.000Z",
    ...overrides,
  };
}

function clientRecord(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    id: CLIENT_ID,
    first_name: "Sallie",
    last_name: "Debolt",
    email: "sallie@example.test",
    phone: null,
    birthday: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state: null,
    postal_code: null,
    country: null,
    status: "active",
    skill_level: null,
    dance_interests: null,
    dance_goals: null,
    referral_source: null,
    photo_url: null,
    notes: null,
    is_independent_instructor: false,
    linked_instructor_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type FakeAdminConfig = {
  accountLinks?: { data: Row[] | null; error: { message: string } | null };
  /** When set, the client_account_links query REJECTS (a genuine thrown/rejected failure, not a resolved `.error` field) instead of resolving. */
  rejectAccountLinksWith?: Error;
  deliveries?: { data: Row[] | null; error: { message: string } | null };
  linkedProfile?: { data: Row | null; error: { message: string } | null };
  matchingProfile?: { data: Row[] | null; error: { message: string } | null };
  getUserById?: { data: { user: Row | null }; error: { message: string } | null };
  /** One entry per expected auth.admin.listUsers page, consumed in order. */
  listUsersPages?: Array<{ data: { users: Row[] } | null; error: { message: string } | null }>;
};

function createFakeAdminClient(config: FakeAdminConfig) {
  const accountLinks = config.accountLinks ?? { data: [clientAccountLinkRow()], error: null };
  const deliveries = config.deliveries ?? { data: [deliveryRow()], error: null };
  const linkedProfile =
    config.linkedProfile ?? {
      data: { id: LINKED_USER_ID, email: "sallie@example.test", full_name: "Sallie Debolt", created_at: null, updated_at: null },
      error: null,
    };
  const matchingProfile =
    config.matchingProfile ?? {
      data: [{ id: LINKED_USER_ID, email: "sallie@example.test", full_name: "Sallie Debolt", created_at: null, updated_at: null }],
      error: null,
    };
  const getUserById =
    config.getUserById ?? {
      data: { user: { id: LINKED_USER_ID, email: "sallie@example.test", email_confirmed_at: "2026-09-01T00:00:00.000Z", last_sign_in_at: null, created_at: null } },
      error: null,
    };
  const listUsersPages = config.listUsersPages ?? [{ data: { users: [] }, error: null }];
  let listUsersCallIndex = 0;

  return {
    // Deliberately no `.schema()` method at all -- if loadClientPortalAdminStatus
    // ever reintroduces `adminSupabase.schema("auth").from("users")`, calling
    // this fake would throw "schema is not a function" and fail the test loudly.
    from(table: string) {
      if (table === "client_account_links") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () =>
                    config.rejectAccountLinksWith
                      ? Promise.reject(config.rejectAccountLinksWith)
                      : Promise.resolve(accountLinks),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "outbound_deliveries") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve(deliveries),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve(linkedProfile),
            }),
            ilike: () => ({
              limit: () => Promise.resolve(matchingProfile),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in fake admin client: ${table}`);
    },
    auth: {
      admin: {
        getUserById: () => Promise.resolve(getUserById),
        listUsers: () => {
          const page = listUsersPages[listUsersCallIndex] ?? { data: { users: [] }, error: null };
          listUsersCallIndex += 1;
          return Promise.resolve(page);
        },
      },
    },
  };
}

let fakeAdminConfig: FakeAdminConfig = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient(fakeAdminConfig),
}));

const { loadClientPortalAdminStatus, findAuthUserByEmail } = await import(
  "@/app/app/clients/[id]/page"
);

beforeEach(() => {
  fakeAdminConfig = {};
});

describe("loadClientPortalAdminStatus -- Sallie Debolt fix", () => {
  it("1/2/3: a healthy linked relationship still returns Connected, preserves invite deliveries, and reports no lookupError when the matching-auth-user (enrichment) lookup fails", async () => {
    fakeAdminConfig = {
      accountLinks: { data: [clientAccountLinkRow()], error: null },
      deliveries: { data: [deliveryRow(), deliveryRow({ id: "delivery-2" })], error: null },
      listUsersPages: [{ data: null, error: { message: "listUsers failed" } }],
    };

    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBeNull();
    expect(status.connectionKind).toBe("linked");
    expect(status.accountLink?.status).toBe("linked");
    expect(status.accountLink?.user_id).toBe(LINKED_USER_ID);
    expect(status.inviteDeliveries).toHaveLength(2);
    expect(status.matchingAuthUser).toBeNull();
  });

  it("4: an actual client_account_links retrieval failure still produces the support warning", async () => {
    fakeAdminConfig = {
      // A real PostgrestError instance, matching what supabase-js actually
      // returns (it extends Error) -- loadClientPortalAdminStatus's
      // `error instanceof Error` branch depends on this.
      accountLinks: { data: null, error: new Error("relation client_account_links does not exist") },
    };

    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBe("relation client_account_links does not exist");
    expect(status.accountLink).toBeNull();
    expect(status.connectionKind).toBe("none");
    expect(status.inviteDeliveries).toEqual([]);
  });

  it("5: an actual invite-delivery retrieval failure also produces the support warning (both are load-bearing)", async () => {
    fakeAdminConfig = {
      deliveries: { data: null, error: new Error("outbound_deliveries query failed") },
    };

    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBe("outbound_deliveries query failed");
    expect(status.accountLink).toBeNull();
    expect(status.inviteDeliveries).toEqual([]);
  });

  it("a genuinely rejected (not merely .error-returning) load-bearing query degrades gracefully instead of crashing the page: loadClientPortalAdminStatus never throws", async () => {
    fakeAdminConfig = {
      rejectAccountLinksWith: new Error("network exploded"),
    };

    // The function's own call site (the page component's render body) has
    // no surrounding try/catch -- if this ever threw instead of resolving,
    // the whole client detail page would crash for staff, which is worse
    // than the pre-fix "Not Connected" bug this whole fix exists to solve.
    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBe("network exploded");
    expect(status.accountLink).toBeNull();
    expect(status.connectionKind).toBe("none");
    expect(status.inviteDeliveries).toEqual([]);
  });

  it("6: uses the Admin Auth API (auth.admin.listUsers) instead of schema(\"auth\") -- succeeds against a fake client with no .schema() method", async () => {
    fakeAdminConfig = {
      listUsersPages: [
        {
          data: {
            users: [
              { id: LINKED_USER_ID, email: "sallie@example.test", email_confirmed_at: "2026-09-01T00:00:00.000Z", last_sign_in_at: "2026-09-01T12:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
            ],
          },
          error: null,
        },
      ],
    };

    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBeNull();
    expect(status.matchingAuthUser).toMatchObject({ id: LINKED_USER_ID, email: "sallie@example.test" });
  });

  it("linked-profile enrichment failure leaves linkedProfile null without erasing accountLink", async () => {
    fakeAdminConfig = {
      linkedProfile: { data: null, error: { message: "profiles lookup failed" } },
    };

    const status = await loadClientPortalAdminStatus(clientRecord(), STUDIO_ID);

    expect(status.lookupError).toBeNull();
    expect(status.linkedProfile).toBeNull();
    expect(status.accountLink?.status).toBe("linked");
  });

  it("no client email short-circuits to the empty status without querying anything", async () => {
    const status = await loadClientPortalAdminStatus(clientRecord({ email: "  " }), STUDIO_ID);

    expect(status).toEqual({
      lookupError: null,
      linkedProfile: null,
      matchingProfile: null,
      matchingAuthUser: null,
      linkedAuthUser: null,
      inviteDeliveries: [],
      connectionKind: "none",
      accountLink: null,
    });
  });
});

describe("findAuthUserByEmail -- Sallie Debolt fix (Admin Auth API pattern)", () => {
  it("paginates auth.admin.listUsers and returns a case-insensitive email match", async () => {
    // Page 1 must return exactly `perPage` (200) users for the loop to
    // continue to page 2 -- a short first page is treated as the last
    // page, matching real pagination semantics.
    const fullFirstPage = Array.from({ length: 200 }, (_, i) => ({
      id: `filler-${i}`,
      email: `filler-${i}@example.test`,
      email_confirmed_at: null,
      last_sign_in_at: null,
      created_at: null,
    }));
    const adminClient = createFakeAdminClient({
      listUsersPages: [
        { data: { users: fullFirstPage }, error: null },
        { data: { users: [{ id: LINKED_USER_ID, email: "Sallie@Example.test", email_confirmed_at: "2026-09-01T00:00:00.000Z", last_sign_in_at: null, created_at: null }] }, error: null },
      ],
    });

    const result = await findAuthUserByEmail(adminClient as never, "sallie@example.test");

    expect(result).toMatchObject({ id: LINKED_USER_ID, email: "Sallie@Example.test" });
  });

  it("returns null when no auth user matches", async () => {
    const adminClient = createFakeAdminClient({
      listUsersPages: [{ data: { users: [] }, error: null }],
    });

    const result = await findAuthUserByEmail(adminClient as never, "nobody@example.test");

    expect(result).toBeNull();
  });

  it("propagates a genuine listUsers error", async () => {
    const adminClient = createFakeAdminClient({
      listUsersPages: [{ data: null, error: { message: "Admin API unavailable" } }],
    });

    await expect(findAuthUserByEmail(adminClient as never, "sallie@example.test")).rejects.toMatchObject({
      message: "Admin API unavailable",
    });
  });
});
