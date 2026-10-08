import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C, end to end through the real scheduled ARIA operations run (generation -> cooldown/dedupe ->
 * reconciliation -> approved-action execution), against an in-memory database.
 */

const state: { db: FakeSupabase } = { db: new FakeSupabase() };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: async () => ({}) }));

const A = "studio-a";
const B = "studio-b";
const ACTOR = "user-owner";
const DAY = 24 * 60 * 60 * 1000;

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeSupabase({
    studios: [
      { id: A, name: "Studio A", public_name: null, slug: "studio-a", public_logo_url: null },
      { id: B, name: "Studio B", public_name: null, slug: "studio-b", public_logo_url: null },
    ],
    clients: [
      { id: "client-1", studio_id: A, first_name: "Robin", last_name: "Lee", email: "robin@example.test", status: "lead", created_at: "2026-01-01T00:00:00.000Z" },
    ],
    client_packages: [
      {
        id: "pkg-old",
        studio_id: A,
        client_id: "client-1",
        name_snapshot: "Starter 5",
        active: true,
        expiration_date: null,
        client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false }],
      },
    ],
    client_package_items: [
      { client_package_id: "pkg-old", studio_id: A, usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ],
    automation_actions: [],
    automation_action_events: [],
    outbound_deliveries: [],
    ...extra,
  });
}

async function scheduledRun(studioId = A) {
  const { runScheduledAriaOperationsForStudio } = await import("@/app/app/automations/actions");
  return runScheduledAriaOperationsForStudio({
    studioId,
    actorUserId: ACTOR,
    includeStudioSignals: true,
    includeOrganizerSignals: false,
  });
}

function lowPackageActions(db: FakeSupabase) {
  return db.rows("automation_actions").filter((row) => row.rule_key === "aria_low_package_balance");
}

function recordExternalSale(db: FakeSupabase) {
  // Staff record an external sale in DanceFlow: a new active package with a full balance for the same client.
  db.rows("client_packages").push({
    id: "pkg-new",
    studio_id: A,
    client_id: "client-1",
    name_snapshot: "Starter 10",
    active: true,
    expiration_date: null,
    client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 10, is_unlimited: false }],
  });
  db.rows("client_package_items").push({
    client_package_id: "pkg-new",
    studio_id: A,
    usage_type: "private_lesson",
    quantity_remaining: 10,
    is_unlimited: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("S. external sale recorded -> stale package action closes and stays closed", () => {
  it("creates the action, reconciles it to completed after the sale, does not email or recreate it", async () => {
    state.db = seed({
      // a non-auto-approving policy keeps step 1 a stored, open action (no email) so the sequence is clear
      aria_action_policies: [
        { studio_id: A, rule_key: "aria_low_package_balance", pack_key: "sales_retention", enabled: true, auto_approve: false },
      ],
    });

    // 1-2. ARIA creates the renewal action and it stays stored
    await scheduledRun();
    const [created] = lowPackageActions(state.db);
    expect(created).toMatchObject({ status: "suggested", related_id: "pkg-old" });

    // 3-4. external sale recorded, valid active package added
    recordExternalSale(state.db);

    // 5-7. next run reconciles: completed with audit evidence
    await scheduledRun();
    expect(lowPackageActions(state.db)).toHaveLength(1);
    expect(created.status).toBe("completed");
    expect(created.review_note).toContain("another active package");
    const completedEvents = state.db
      .rows("automation_action_events")
      .filter((event) => event.automation_action_id === created.id && event.event_type === "completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].metadata).toMatchObject({ source: "aria_condition_reconciliation" });

    // 9. not recreated / not re-approved by later runs; no email queued for it
    await scheduledRun();
    await scheduledRun();
    expect(lowPackageActions(state.db)).toHaveLength(1);
    expect(created.status).toBe("completed");
    expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
  });

  it("with the default auto-approve + auto-send policy, a resolved action is completed instead of emailed", async () => {
    state.db = seed();
    // first run would normally auto-approve AND send; record the sale before it
    await scheduledRun();
    const [created] = lowPackageActions(state.db);
    // the first run legitimately executed the still-valid action
    expect(["queued", "approved"]).toContain(created.status);

    // a second, separate low package for a different client: created approved, then resolved before execution
    state.db = seed();
    state.db.rows("aria_action_policies").push({
      studio_id: A,
      rule_key: "aria_low_package_balance",
      pack_key: "sales_retention",
      enabled: true,
      auto_approve: true,
      max_auto_approve_priority: "urgent",
    });
    state.db.rows("automation_actions").push({
      id: "approved-stale",
      studio_id: A,
      rule_key: "aria_low_package_balance",
      related_table: "client_packages",
      related_id: "pkg-old",
      client_id: "client-1",
      status: "approved",
      title: "Package renewal opportunity",
      body: "",
      created_at: "2026-10-07T00:00:00.000Z",
    });
    recordExternalSale(state.db);
    await scheduledRun();
    const stale = state.db.rows("automation_actions").find((row) => row.id === "approved-stale")!;
    expect(stale.status).toBe("completed");
    expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
    expect(lowPackageActions(state.db)).toHaveLength(1);
  });
});

describe("J/K/Q. terminal rows are never re-approved or rewritten", () => {
  for (const terminal of ["dismissed", "completed"] as const) {
    it(`${terminal} low-package action inside the 30-day cooldown stays ${terminal}, and no duplicate is created`, async () => {
      state.db = seed({
        aria_action_policies: [
          {
            studio_id: A,
            rule_key: "aria_low_package_balance",
            pack_key: "sales_retention",
            enabled: true,
            auto_approve: true,
            max_auto_approve_priority: "urgent",
          },
        ],
        automation_actions: [
          {
            id: "terminal-1",
            studio_id: A,
            rule_key: "aria_low_package_balance",
            related_table: "client_packages",
            related_id: "pkg-old",
            client_id: "client-1",
            status: terminal,
            review_note: "Staff closed this.",
            created_at: new Date(Date.now() - 5 * DAY).toISOString(),
          },
        ],
      });

      // the underlying condition still exists (balance 1, no replacement)
      await scheduledRun();
      await scheduledRun();

      const rows = lowPackageActions(state.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "terminal-1", status: terminal, review_note: "Staff closed this." });
      expect(state.db.rows("automation_action_events").filter((event) => event.automation_action_id === "terminal-1")).toHaveLength(0);
      expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
    });
  }

  it("R: after the cooldown, a genuine recurrence creates a NEW action and leaves the old terminal row alone", async () => {
    state.db = seed({
      aria_action_policies: [
        { studio_id: A, rule_key: "aria_low_package_balance", pack_key: "sales_retention", enabled: true, auto_approve: false },
      ],
      automation_actions: [
        {
          id: "old-dismissed",
          studio_id: A,
          rule_key: "aria_low_package_balance",
          related_table: "client_packages",
          related_id: "pkg-old",
          client_id: "client-1",
          status: "dismissed",
          review_note: "Not now.",
          created_at: new Date(Date.now() - 45 * DAY).toISOString(),
        },
      ],
    });
    await scheduledRun();
    const rows = lowPackageActions(state.db);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "old-dismissed")).toMatchObject({ status: "dismissed", review_note: "Not now." });
    expect(rows.find((row) => row.id !== "old-dismissed")).toMatchObject({ status: "suggested", related_id: "pkg-old" });
  });
});

describe("snooze is respected by generation", () => {
  it("auto-approval policy does not silently unsnooze a snoozed action whose condition still exists", async () => {
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    state.db = seed({
      aria_action_policies: [
        {
          studio_id: A,
          rule_key: "aria_low_package_balance",
          pack_key: "sales_retention",
          enabled: true,
          auto_approve: true,
          max_auto_approve_priority: "urgent",
        },
      ],
      automation_actions: [
        {
          id: "snoozed-1",
          studio_id: A,
          rule_key: "aria_low_package_balance",
          related_table: "client_packages",
          related_id: "pkg-old",
          client_id: "client-1",
          status: "snoozed",
          snoozed_until: until,
          created_at: new Date(Date.now() - 2 * DAY).toISOString(),
        },
      ],
    });
    await scheduledRun();
    const row = state.db.rows("automation_actions").find((action) => action.id === "snoozed-1")!;
    expect(row).toMatchObject({ status: "snoozed", snoozed_until: until });
    expect(lowPackageActions(state.db)).toHaveLength(1);
    expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
  });

  it("M: once the snooze has ended and the condition still exists, the existing policy may act on it again", async () => {
    state.db = seed({
      aria_action_policies: [
        {
          studio_id: A,
          rule_key: "aria_low_package_balance",
          pack_key: "sales_retention",
          enabled: true,
          auto_approve: true,
          max_auto_approve_priority: "urgent",
        },
      ],
      automation_actions: [
        {
          id: "snooze-over",
          studio_id: A,
          rule_key: "aria_low_package_balance",
          related_table: "client_packages",
          related_id: "pkg-old",
          client_id: "client-1",
          status: "snoozed",
          snoozed_until: new Date(Date.now() - 60 * 1000).toISOString(),
          created_at: new Date(Date.now() - 4 * DAY).toISOString(),
        },
      ],
    });
    await scheduledRun();
    const row = state.db.rows("automation_actions").find((action) => action.id === "snooze-over")!;
    expect(["approved", "queued"]).toContain(row.status);
    expect(lowPackageActions(state.db)).toHaveLength(1);
  });
});

describe("cross-studio", () => {
  it("studio B's run never touches studio A's actions or reads A's packages", async () => {
    state.db = seed({
      automation_actions: [
        {
          id: "a-open",
          studio_id: A,
          rule_key: "aria_low_package_balance",
          related_table: "client_packages",
          related_id: "pkg-old",
          client_id: "client-1",
          status: "suggested",
          created_at: "2026-10-07T00:00:00.000Z",
        },
      ],
    });
    recordExternalSale(state.db); // A's condition is resolved, but only A's own run may close A's action
    await scheduledRun(B);
    expect(state.db.rows("automation_actions").find((row) => row.id === "a-open")?.status).toBe("suggested");
    const touchedA = state.db.operations.filter(
      (operation) => operation.eqs.some(([column, value]) => column === "studio_id" && value === A),
    );
    expect(touchedA).toHaveLength(0);
  });
});
