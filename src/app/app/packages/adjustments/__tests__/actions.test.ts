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

/**
 * Package Refund P0, Slice 2c-2 (concurrency hardening): createBalanceAdjustmentAction
 * now delegates its computation, validation, item mutation, and ledger write
 * to apply_package_balance_adjustment via createAdminClient().rpc(...),
 * replacing what used to be a plain, unlocked .update() against the
 * `supabase` fake above. This fake RPC handler reproduces that SQL
 * function's exact logic (same validation order, same computed values, same
 * ledger note format -- see the migration itself,
 * 20260823091500_package_item_manual_mutation_rpcs.sql, and its local-Docker
 * regression suite, test_O_manual_mutation_rpcs.sql, which is the
 * authoritative behavioral proof) against the SAME `currentTables` fixture
 * the `supabase` fake reads from, so reconcileClientPackageLifecycle (called
 * afterward, through the ordinary `supabase` client) observes the mutated
 * state correctly.
 */
function createFakeAdminClient(tables: ReturnType<typeof buildTables>) {
  return {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name !== "apply_package_balance_adjustment") {
        throw new Error(`Unexpected RPC in fake admin client: ${name}`);
      }

      const pkg = tables.client_packages.rows.find(
        (r) => r.id === params.p_client_package_id && r.studio_id === params.p_studio_id,
      );
      if (!pkg) {
        return { data: null, error: { message: "Client package lookup failed: package not found." } };
      }

      const item = tables.client_package_items.rows.find(
        (r) =>
          r.client_package_id === params.p_client_package_id &&
          r.studio_id === params.p_studio_id &&
          r.usage_type === params.p_usage_type,
      );
      if (!item) {
        return { data: null, error: { message: "Package item lookup failed: package item not found." } };
      }
      if (item.is_unlimited) {
        return { data: null, error: { message: "Unlimited package items cannot be adjusted with quantity changes." } };
      }

      const quantity = Number(params.p_quantity);
      const delta = params.p_adjustment_type === "add" ? quantity : -quantity;
      const nextRemaining = Number(item.quantity_remaining ?? 0) + delta;
      const nextTotal = Number(item.quantity_total ?? 0) + delta;

      if (nextRemaining < 0) {
        return { data: null, error: { message: "This adjustment would make the remaining balance negative." } };
      }
      if (nextTotal < 0) {
        return { data: null, error: { message: "This adjustment would make the total balance negative." } };
      }

      let nextUsed = Number(item.quantity_used ?? 0);
      if (nextUsed > nextTotal) nextUsed = nextTotal;

      item.quantity_total = nextTotal;
      item.quantity_used = nextUsed;
      item.quantity_remaining = nextRemaining;

      const transactionType = params.p_adjustment_type === "add" ? "manual_credit" : "manual_debit";
      tables.lesson_transactions.insert({
        studio_id: params.p_studio_id,
        client_id: pkg.client_id,
        client_package_id: pkg.id,
        transaction_type: transactionType,
        lessons_delta: delta,
        balance_after: nextRemaining,
        notes: `[${params.p_usage_type}] ${params.p_notes}`,
        created_by: params.p_created_by,
      });

      return {
        data: [{ new_quantity_total: nextTotal, new_quantity_used: nextUsed, new_quantity_remaining: nextRemaining }],
        error: null,
      };
    },
  };
}

vi.mock("@/lib/auth/serverRoleGuard", () => ({
  requireBalanceAdjustmentAccess: async () => ({
    supabase: createFakeEntitlementClient(currentTables),
    studioId: STUDIO_ID,
    user: { id: ACTOR_ID },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient(currentTables),
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

describe("createBalanceAdjustmentAction -- behavioral parity with the pre-2c-2 unlocked implementation", () => {
  it("computes the same values and ledger note format the old .update() path produced", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "group_class",
      quantity_total: 5,
      quantity_used: 2,
      quantity_remaining: 3,
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

    await expectRedirectOrError(
      createBalanceAdjustmentAction(
        { error: "" },
        formDataFor({
          clientPackageId: "pkg-1",
          usageType: "group_class",
          adjustmentType: "add",
          quantity: "2.5",
          notes: "Prorated credit",
        }),
      ),
    );

    expect(tables.client_package_items.rows[0]).toMatchObject({
      quantity_total: 7.5,
      quantity_used: 2,
      quantity_remaining: 5.5,
    });
    expect(tables.lesson_transactions.rows[0]).toMatchObject({
      transaction_type: "manual_credit",
      lessons_delta: 2.5,
      balance_after: 5.5,
      notes: "[group_class] Prorated credit",
      created_by: ACTOR_ID,
    });
  });

  it("surfaces the RPC's unlimited-item rejection as a form error, not a thrown exception", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "practice_party",
      quantity_total: null,
      quantity_used: 0,
      quantity_remaining: null,
      is_unlimited: true,
    };
    setFixture({
      client_packages: [
        { id: "pkg-1", studio_id: STUDIO_ID, client_id: CLIENT_ID, name_snapshot: "Unlimited", active: true },
      ],
      client_package_items: [item],
    });

    const result = await createBalanceAdjustmentAction(
      { error: "" },
      formDataFor({
        clientPackageId: "pkg-1",
        usageType: "practice_party",
        adjustmentType: "add",
        quantity: "1",
        notes: "n/a",
      }),
    );

    expect(result.error).toBe("Unlimited package items cannot be adjusted with quantity changes.");
  });

  it("surfaces the RPC's negative-balance rejection as a form error", async () => {
    const item: Row = {
      id: "item-1",
      studio_id: STUDIO_ID,
      client_package_id: "pkg-1",
      usage_type: "private_lesson",
      quantity_total: 5,
      quantity_used: 4,
      quantity_remaining: 1,
      is_unlimited: false,
    };
    setFixture({
      client_packages: [
        { id: "pkg-1", studio_id: STUDIO_ID, client_id: CLIENT_ID, name_snapshot: "5-pack", active: true },
      ],
      client_package_items: [item],
    });

    const result = await createBalanceAdjustmentAction(
      { error: "" },
      formDataFor({
        clientPackageId: "pkg-1",
        usageType: "private_lesson",
        adjustmentType: "remove",
        quantity: "5",
        notes: "too much",
      }),
    );

    expect(result.error).toBe("This adjustment would make the remaining balance negative.");
  });
});
