import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C2, end to end: generation keeps the wording of open actions current, the Morning Briefing refreshes and
 * reconciles before selecting, and the C1 incident rules (same-incident suppression, genuine recurrence, no duplicate
 * of a queued action) hold for the newly handled rules too.
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
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

function seed(extra: Record<string, Record<string, unknown>[]>) {
  return new FakeSupabase({
    studios: [{ id: A, name: "Studio A", public_name: null, slug: "studio-a", public_logo_url: null, timezone: "America/New_York" }],
    profiles: [{ id: "owner", full_name: "Owner", email: "owner@example.test" }],
    automation_actions: [],
    automation_action_events: [],
    outbound_deliveries: [],
    aria_digest_runs: [],
    ...extra,
  });
}

async function scheduledRun() {
  const { runScheduledAriaOperationsForStudio } = await import("@/app/app/automations/actions");
  return runScheduledAriaOperationsForStudio({
    studioId: A,
    actorUserId: "owner",
    includeStudioSignals: true,
    includeOrganizerSignals: false,
  });
}

function actionsFor(ruleKey: string) {
  return state.db.rows("automation_actions").filter((row) => row.rule_key === ruleKey);
}

const lowStock = (onHand: number) => ({
  commerce_product_variant_inventory: [
    { id: "inv-1", studio_id: A, catalog_item_id: null, name: "Practice shoes", quantity_on_hand: onHand, reorder_threshold: 3, active: true },
  ],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("generation keeps wording current while the condition still holds", () => {
  it("low stock '2 on hand' becomes '1 on hand' on the next run, on the same action", async () => {
    state.db = seed(lowStock(2));
    await scheduledRun();
    const [created] = actionsFor("aria_inventory_low_stock");
    expect(String(created.body)).toContain("has 2 on hand");

    state.db.rows("commerce_product_variant_inventory")[0].quantity_on_hand = 1;
    await scheduledRun();
    expect(actionsFor("aria_inventory_low_stock")).toHaveLength(1);
    expect(String(created.body)).toContain("has 1 on hand");
    expect(String(created.body)).not.toContain("has 2 on hand");
  });

  it("restocked -> completed by reconciliation in the same run, and not recreated", async () => {
    state.db = seed(lowStock(2));
    await scheduledRun();
    state.db.rows("commerce_product_variant_inventory")[0].quantity_on_hand = 20;
    await scheduledRun();
    await scheduledRun();
    const rows = actionsFor("aria_inventory_low_stock");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  it("genuine recurrence after a system-observed restock creates a new action", async () => {
    state.db = seed(lowStock(2));
    await scheduledRun();
    state.db.rows("commerce_product_variant_inventory")[0].quantity_on_hand = 20;
    await scheduledRun();
    state.db.rows("commerce_product_variant_inventory")[0].quantity_on_hand = 0;
    await scheduledRun();
    expect(actionsFor("aria_inventory_low_stock").map((row) => row.status).sort()).toEqual(["completed", "suggested"]);
  });
});

describe("same-incident rules hold for newly handled rules", () => {
  it("a dismissed instructor-coverage action is not regenerated for the same appointment; another appointment is new", async () => {
    state.db = seed({
      appointments: [
        { id: "appt-1", studio_id: A, client_id: null, instructor_id: null, appointment_type: "private_lesson", status: "scheduled", starts_at: at(2), payment_status: "unpaid", price_amount: 0 },
      ],
    });
    await scheduledRun();
    const [first] = actionsFor("aria_instructor_coverage_gap");
    Object.assign(first, { status: "dismissed", dismissed_at: NOW.toISOString() });
    await scheduledRun();
    expect(actionsFor("aria_instructor_coverage_gap")).toHaveLength(1);

    state.db.rows("appointments").push({
      id: "appt-2",
      studio_id: A,
      client_id: null,
      instructor_id: null,
      appointment_type: "private_lesson",
      status: "scheduled",
      starts_at: at(3),
      payment_status: "unpaid",
      price_amount: 0,
    });
    await scheduledRun();
    expect(actionsFor("aria_instructor_coverage_gap").map((row) => row.related_id).sort()).toEqual(["appt-1", "appt-2"]);
  });

  it("a queued action is not duplicated and its wording is not rewritten", async () => {
    state.db = seed({
      ...lowStock(1),
      automation_actions: [
        {
          id: "queued-1",
          studio_id: A,
          rule_key: "aria_inventory_low_stock",
          related_table: "commerce_product_variant_inventory",
          related_id: "inv-1",
          status: "queued",
          title: "Low stock: Practice shoes",
          body: "as sent",
          priority: "high",
          created_at: at(-1),
        },
      ],
    });
    await scheduledRun();
    const rows = actionsFor("aria_inventory_low_stock");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "queued", body: "as sent" });
  });
});

describe("Morning Briefing truthfulness", () => {
  it("refreshes stale wording and drops expired / resolved actions before reporting", async () => {
    state.db = seed({
      ...lowStock(1),
      appointments: [
        // coverage gap whose appointment already started -> expires
        { id: "appt-past", studio_id: A, client_id: null, instructor_id: null, appointment_type: "private_lesson", status: "scheduled", starts_at: at(-0.1), payment_status: "unpaid", price_amount: 0 },
      ],
      marketing_campaigns: [{ id: "mc-1", studio_id: A, name: "Fall promo", status: "sent", created_at: at(-30) }],
      automation_actions: [
        {
          id: "stock",
          studio_id: A,
          rule_key: "aria_inventory_low_stock",
          related_table: "commerce_product_variant_inventory",
          related_id: "inv-1",
          status: "suggested",
          title: "Low stock: Practice shoes",
          body: "Practice shoes has 3 on hand with a reorder threshold of 3. (stale)",
          priority: "high",
          due_at: at(0),
          created_at: at(-2),
        },
        {
          id: "coverage",
          studio_id: A,
          rule_key: "aria_instructor_coverage_gap",
          related_table: "appointments",
          related_id: "appt-past",
          status: "approved",
          title: "Instructor coverage needed",
          body: "no instructor",
          priority: "urgent",
          due_at: at(-1),
          created_at: at(-2),
        },
        {
          id: "marketing",
          studio_id: A,
          rule_key: "aria_marketing_opportunity",
          related_table: "marketing_campaigns",
          related_id: "mc-1",
          status: "suggested",
          title: "Marketing draft needs a decision: Fall promo",
          body: "still in draft",
          priority: "normal",
          due_at: at(0),
          created_at: at(-2),
        },
      ],
    });
    const { processDigestRun } = await import("@/app/api/cron/aria-digest/route");
    await processDigestRun({
      preference: {
        studio_id: A,
        morning_digest_enabled: true,
        end_of_day_digest_enabled: false,
        delivery_channel: "in_app",
        default_recipient_user_id: "owner",
        morning_digest_time: "08:00",
        end_of_day_digest_time: null,
      },
      digestType: "morning",
      digestDate: "2026-10-08",
      now: NOW,
    });

    const byId = (id: string) => state.db.rows("automation_actions").find((row) => row.id === id)!;
    expect(String(byId("stock").body)).toContain("has 1 on hand");
    expect(byId("coverage").status).toBe("skipped");
    expect(byId("marketing").status).toBe("completed");

    const summary = state.db.rows("aria_digest_runs")[0].summary as { open_actions: number; top_actions: Array<{ id: string }> };
    expect(summary.top_actions.map((item) => item.id)).toEqual(["stock"]);
    expect(summary.open_actions).toBe(1);
  });
});

describe("Operations Center and Opportunity Hub run the same handlers before reading actions", () => {
  it("both pages reconcile current state first", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of ["src/app/app/aria/operations/page.tsx", "src/app/app/aria/page.tsx"]) {
      const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const hook = source.indexOf("await reconcileAriaActionsForStudio({ supabase, studioId });");
      const firstActionRead = source.indexOf('.from("automation_actions")');
      expect(hook).toBeGreaterThan(-1);
      expect(hook).toBeLessThan(firstActionRead);
    }
  });
});
