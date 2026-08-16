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

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireBalanceAdjustmentAccess: async () => ({
    supabase: createFakeEntitlementClient(currentTables),
    studioId: STUDIO_ID,
    user: { id: ACTOR_ID },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const { createBalanceAdjustmentAction } = await import("@/app/app/packages/adjustments/actions");

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirectOrError(promise: Promise<{ error: string }>) {
  try {
    const result = await promise;
    return { redirected: false as const, error: result.error };
  } catch (error) {
    const digest = (error as { digest?: string }).digest;
    if (!digest) throw error;
    return { redirected: true as const, digest };
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createBalanceAdjustmentAction -- lifecycle reconciliation", () => {
  it("10. removing the last credit reconciles the package to inactive", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "private_lesson",
      quantity_total: 1,
      quantity_used: 0,
      quantity_remaining: 1,
      is_unlimited: false,
    };
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          name_snapshot: "1-pack",
          active: true,
          client_package_items: [item],
        },
      ],
      client_package_items: [item],
    });

    const outcome = await expectRedirectOrError(
      createBalanceAdjustmentAction(
        { error: "" },
        formDataFor({
          clientPackageId: "pkg-1",
          usageType: "private_lesson",
          adjustmentType: "remove",
          quantity: "1",
          notes: "Used outside system",
        }),
      ),
    );

    expect(outcome.redirected).toBe(true);
    expect(tables.client_packages.rows[0].active).toBe(false);
  });

  it("adding credits to a package leaves it active", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "private_lesson",
      quantity_total: 5,
      quantity_used: 5,
      quantity_remaining: 0,
      is_unlimited: false,
    };
    const tables = setFixture({
      client_packages: [
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          name_snapshot: "5-pack",
          active: true,
          client_package_items: [item],
        },
      ],
      client_package_items: [item],
    });

    const outcome = await expectRedirectOrError(
      createBalanceAdjustmentAction(
        { error: "" },
        formDataFor({
          clientPackageId: "pkg-1",
          usageType: "private_lesson",
          adjustmentType: "add",
          quantity: "2",
          notes: "Goodwill credit",
        }),
      ),
    );

    expect(outcome.redirected).toBe(true);
    expect(tables.client_packages.rows[0].active).toBe(true);
  });
});
