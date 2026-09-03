import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

/**
 * H3: the login-time cross-studio routing decision. A portal user can hold
 * simultaneous `linked` client_account_links rows across multiple different
 * studios (H2-B2 RLS already assumes and supports this) as well as multiple
 * rows within one studio (self + guardian). The decision unit for H3 is a
 * *studio*, not a raw row: multiple rows within one studio are not
 * ambiguous for login routing (resolvePortalRelationship()/the `?client=`
 * param already solve that once inside a studio); only multiple distinct
 * studios are a genuine login-time choice.
 *
 * This suite covers listLinkedPortalDestinations (the fetch, scoped to the
 * exact user + status='linked') and decidePortalDestination (the pure
 * grouping/tie-break/ambiguity decision), which together replace the old
 * getLinkedPortalDestination's silent single-row pick.
 */

const STUDIO_A = "studio-a";
const STUDIO_B = "studio-b";
const STUDIO_C = "studio-c";
const USER_ID = "user-1";
const OTHER_USER_ID = "user-2";
const CLIENT_SELF = "client-self";
const CLIENT_GUARDIAN = "client-guardian";
const CLIENT_B = "client-b";
const CLIENT_INSTRUCTOR = "client-instructor";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

let currentTables: { client_account_links: FakeTable };

function setFixture(rows: Row[]) {
  currentTables = { client_account_links: table(rows) };
  return currentTables;
}

function linkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: `link-${Math.random().toString(36).slice(2)}`,
    user_id: USER_ID,
    studio_id: STUDIO_A,
    client_id: CLIENT_SELF,
    relationship_type: "self",
    is_primary: false,
    status: "linked",
    created_at: "2026-01-01T00:00:00.000Z",
    studios: { slug: "studio-a-slug", name: "Studio A", public_name: null },
    clients: { is_independent_instructor: false },
    ...overrides,
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeEntitlementClient(currentTables),
}));

const {
  listLinkedPortalDestinations,
  decidePortalDestination,
  resolveDestinationForStudio,
} = await import("@/lib/auth/portal-linking");

describe("listLinkedPortalDestinations", () => {
  it("scopes strictly to the given user_id and status='linked', ignoring other users and non-linked rows", async () => {
    setFixture([
      linkRow({ user_id: USER_ID, studio_id: STUDIO_A, client_id: CLIENT_SELF }),
      linkRow({ user_id: OTHER_USER_ID, studio_id: STUDIO_B, client_id: "someone-elses-client" }),
      linkRow({ user_id: USER_ID, studio_id: STUDIO_B, client_id: CLIENT_B, status: "disconnected" }),
      linkRow({ user_id: USER_ID, studio_id: STUDIO_C, client_id: "former-client", status: "former_client" }),
    ]);

    const rows = await listLinkedPortalDestinations(USER_ID);

    expect(rows).toHaveLength(1);
    expect(rows[0].studioId).toBe(STUDIO_A);
    expect(rows[0].clientId).toBe(CLIENT_SELF);
  });
});

describe("decidePortalDestination", () => {
  it("0 rows -> none", () => {
    expect(decidePortalDestination([], null)).toEqual({ type: "none" });
  });

  it("exactly 1 row -> single, auto-route", async () => {
    setFixture([linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF })]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, null);
    expect(decision).toEqual({
      type: "single",
      path: "/portal/studio-a-slug?client=client-self",
    });
  });

  it("two rows at the SAME studio (self + guardian) -> single, not multiple -- same-studio multiplicity must never trigger the chooser", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        relationship_type: "self",
        is_primary: true,
        created_at: "2026-01-02T00:00:00.000Z",
      }),
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_GUARDIAN,
        relationship_type: "guardian",
        is_primary: false,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, null);
    expect(decision.type).toBe("single");
    if (decision.type === "single") {
      expect(decision.path).toBe("/portal/studio-a-slug?client=client-self");
    }
  });

  it("two rows at DIFFERENT studios, no remembered cookie -> multiple, both present", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        studios: { slug: "studio-a-slug", name: "Studio A", public_name: null },
      }),
      linkRow({
        studio_id: STUDIO_B,
        client_id: CLIENT_B,
        studios: { slug: "studio-b-slug", name: "Studio B", public_name: "Studio B Public" },
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, null);
    expect(decision.type).toBe("multiple");
    if (decision.type === "multiple") {
      expect(decision.options.map((o) => o.studioId).sort()).toEqual(
        [STUDIO_A, STUDIO_B].sort(),
      );
    }
  });

  it("two different studios, a VALID remembered studio -> single, bypasses the chooser", async () => {
    setFixture([
      linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF }),
      linkRow({
        studio_id: STUDIO_B,
        client_id: CLIENT_B,
        studios: { slug: "studio-b-slug", name: "Studio B", public_name: null },
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, STUDIO_B);
    expect(decision).toEqual({
      type: "single",
      path: "/portal/studio-b-slug?client=client-b",
    });
  });

  it("two different studios, a STALE remembered studio (no longer linked) -> falls back to multiple, never trusted blindly", async () => {
    setFixture([
      linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF }),
      linkRow({
        studio_id: STUDIO_B,
        client_id: CLIENT_B,
        studios: { slug: "studio-b-slug", name: "Studio B", public_name: null },
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, STUDIO_C);
    expect(decision.type).toBe("multiple");
    if (decision.type === "multiple") {
      expect(decision.options.map((o) => o.studioId).sort()).toEqual(
        [STUDIO_A, STUDIO_B].sort(),
      );
    }
  });

  it("independent-instructor-only row at one studio, regular row at another -> both appear in multiple, correctly labeled", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        clients: { is_independent_instructor: false },
      }),
      linkRow({
        studio_id: STUDIO_B,
        client_id: CLIENT_INSTRUCTOR,
        relationship_type: "self",
        studios: { slug: "studio-b-slug", name: "Studio B", public_name: null },
        clients: { is_independent_instructor: true },
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const decision = decidePortalDestination(rows, null);
    expect(decision.type).toBe("multiple");
    if (decision.type === "multiple") {
      const studioA = decision.options.find((o) => o.studioId === STUDIO_A);
      const studioB = decision.options.find((o) => o.studioId === STUDIO_B);
      expect(studioA?.isIndependentInstructor).toBe(false);
      expect(studioB?.isIndependentInstructor).toBe(true);
    }
  });

  it("within-studio tie-break: is_primary wins over an earlier created_at", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_GUARDIAN,
        is_primary: false,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        is_primary: true,
        created_at: "2026-01-05T00:00:00.000Z",
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const destination = resolveDestinationForStudio(rows, STUDIO_A);
    expect(destination?.clientId).toBe(CLIENT_SELF);
  });

  it("within-studio tie-break: earliest created_at wins when no row is primary", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        is_primary: false,
        created_at: "2026-01-05T00:00:00.000Z",
      }),
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_GUARDIAN,
        is_primary: false,
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const destination = resolveDestinationForStudio(rows, STUDIO_A);
    expect(destination?.clientId).toBe(CLIENT_GUARDIAN);
  });

  it("within-studio tie-break: compares createdAt as numeric instants, not raw ISO strings -- mixed UTC-offset representations still resolve to the actual earlier instant", async () => {
    setFixture([
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_SELF,
        is_primary: false,
        // 2026-01-02T04:00:00Z -- the LATER instant, despite sorting before
        // the row below as a raw string (lexicographically "01-01" < "01-02").
        // A naive string comparison of createdAt would incorrectly rank this
        // row as "earliest" and pick it.
        created_at: "2026-01-01T23:00:00-05:00",
      }),
      linkRow({
        studio_id: STUDIO_A,
        client_id: CLIENT_GUARDIAN,
        is_primary: false,
        // 2026-01-02T01:00:00Z -- the genuinely EARLIER instant, and the
        // correct "earliest created_at wins" pick.
        created_at: "2026-01-02T01:00:00+00:00",
      }),
    ]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    const destination = resolveDestinationForStudio(rows, STUDIO_A);
    expect(destination?.clientId).toBe(CLIENT_GUARDIAN);
  });
});

describe("resolveDestinationForStudio", () => {
  beforeEach(() => {
    setFixture([]);
  });

  it("returns null for a studioId not present among the given rows (the tamper/stale-cookie guard)", async () => {
    setFixture([linkRow({ studio_id: STUDIO_A, client_id: CLIENT_SELF })]);
    const rows = await listLinkedPortalDestinations(USER_ID);

    expect(resolveDestinationForStudio(rows, STUDIO_C)).toBeNull();
  });
});
