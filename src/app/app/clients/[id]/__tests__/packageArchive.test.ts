import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const ACTOR_ID = "staff-1";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

type Fixture = {
  client_packages?: Row[];
  client_package_items?: Row[];
};

let currentTables: ReturnType<typeof buildTables>;

function buildTables(fixture: Fixture) {
  return {
    client_packages: table(fixture.client_packages ?? []),
    client_package_items: table(fixture.client_package_items ?? []),
    lesson_transactions: table([]),
    automation_actions: table([]),
    automation_action_events: table([]),
  };
}

function setFixture(fixture: Fixture) {
  currentTables = buildTables(fixture);
  return currentTables;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...createFakeEntitlementClient(currentTables),
    auth: {
      getUser: async () => ({ data: { user: { id: ACTOR_ID } } }),
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: STUDIO_ID,
    studioRole: "studio_owner",
  }),
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

const {
  archiveClientPackageAction,
  reactivateClientPackageAction,
  adjustLessonCountCorrectionAction,
} = await import("@/app/app/clients/[id]/actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archiveClientPackageAction", () => {
  it("1. archives a package with remaining balance -- inactive + archive metadata populated, no balance mutation", async () => {
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
        },
      ],
    });

    const result = await archiveClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1", archiveReason: "Client dispute" }),
    );

    expect(result.error).toBe("");
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: false,
      archived_by: ACTOR_ID,
      archive_reason: "Client dispute",
    });
    expect(tables.client_packages.rows[0].archived_at).toBeTruthy();
  });

  it("archiving without a reason leaves archive_reason null", async () => {
    const tables = setFixture({
      client_packages: [
        { id: "pkg-1", studio_id: STUDIO_ID, client_id: CLIENT_ID, active: true, archived_at: null },
      ],
    });

    await archiveClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(tables.client_packages.rows[0].archive_reason).toBeNull();
  });

  it("archiving a package belonging to a different client is rejected", async () => {
    setFixture({
      client_packages: [
        { id: "pkg-1", studio_id: STUDIO_ID, client_id: "other-client", active: true },
      ],
    });

    const result = await archiveClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(result.error).toMatch(/not found/i);
  });
});

describe("reactivateClientPackageAction", () => {
  it("7. a valid reactivation succeeds and clears all archive metadata", async () => {
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          expiration_date: null,
          archived_at: "2026-09-01T00:00:00.000Z",
          archived_by: ACTOR_ID,
          archive_reason: "Client dispute",
          client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
        },
      ],
    });

    const result = await reactivateClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(result.error).toBe("");
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: true,
      archived_at: null,
      archived_by: null,
      archive_reason: null,
    });
  });

  it("8. reactivation is blocked for a zero-balance package, with a clear message and no partial update", async () => {
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          expiration_date: null,
          archived_at: "2026-09-01T00:00:00.000Z",
          archived_by: ACTOR_ID,
          archive_reason: null,
          client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
        },
      ],
    });

    const result = await reactivateClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(result.error).toMatch(/no remaining balance|expired/i);
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: false,
      archived_at: "2026-09-01T00:00:00.000Z",
    });
  });

  it("9. reactivation is blocked for an expired package even with remaining balance, with no partial update", async () => {
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          expiration_date: "2020-01-01",
          archived_at: "2026-09-01T00:00:00.000Z",
          archived_by: ACTOR_ID,
          archive_reason: null,
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ],
    });

    const result = await reactivateClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(result.error).toMatch(/no remaining balance|expired/i);
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: false,
      archived_at: "2026-09-01T00:00:00.000Z",
    });
  });

  it("Package Refund P0, Slice 2b: reactivation is blocked for a refund_status='full' package even with remaining balance and no expiration, with no partial update", async () => {
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          expiration_date: null,
          refund_status: "full",
          archived_at: "2026-09-01T00:00:00.000Z",
          archived_by: ACTOR_ID,
          archive_reason: null,
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ],
    });

    const result = await reactivateClientPackageAction(
      { error: "" },
      formDataFor({ clientId: CLIENT_ID, clientPackageId: "pkg-1" }),
    );

    expect(result.error).toMatch(/no remaining balance|expired/i);
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: false,
      archived_at: "2026-09-01T00:00:00.000Z",
      refund_status: "full",
    });
  });
});

async function expectRedirect(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected a redirect (NEXT_REDIRECT) but none occurred.");
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return digest;
  }
}

describe("adjustLessonCountCorrectionAction -- lifecycle reconciliation", () => {
  it("11. debiting a package item to zero reconciles the package to inactive", async () => {
    // The fake performs no real joins, so `reconcileClientPackageLifecycle`
    // reading `client_packages.client_package_items` as an embedded
    // relation needs to see the SAME object the item-table update mutates
    // -- share one object reference across both fixture representations.
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "private_lesson",
      quantity_total: 1,
      quantity_used: 0,
      quantity_remaining: 1,
      is_unlimited: false,
      client_packages: { id: "pkg-1", client_id: CLIENT_ID, name_snapshot: "10-pack" },
    };
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          client_package_items: [item],
        },
      ],
      client_package_items: [item],
    });

    const digest = await expectRedirect(
      adjustLessonCountCorrectionAction(
        formDataFor({
          clientId: CLIENT_ID,
          packageItemId: "item-1",
          correctionType: "debit",
          quantity: "1",
          reason: "Used outside system",
        }),
      ),
    );

    expect(digest).toMatch(/success=package_correction_saved/);
    expect(tables.client_packages.rows[0].active).toBe(false);
  });

  it("adding credits back to a package leaves it active", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "private_lesson",
      quantity_total: 5,
      quantity_used: 5,
      quantity_remaining: 0,
      is_unlimited: false,
      client_packages: { id: "pkg-1", client_id: CLIENT_ID, name_snapshot: "5-pack" },
    };
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          client_package_items: [item],
        },
      ],
      client_package_items: [item],
    });

    await expectRedirect(
      adjustLessonCountCorrectionAction(
        formDataFor({
          clientId: CLIENT_ID,
          packageItemId: "item-1",
          correctionType: "add",
          quantity: "2",
          reason: "Goodwill credit",
        }),
      ),
    );

    expect(tables.client_packages.rows[0].active).toBe(true);
  });
});
