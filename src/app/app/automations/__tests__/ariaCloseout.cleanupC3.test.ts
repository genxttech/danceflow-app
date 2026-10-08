import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C3 (ARIA truthfulness closeout), end to end against an in-memory database:
 *   - queued actions are not re-presented in the Morning Briefing as current opportunities;
 *   - page-load wording refresh is refresh-only and write-free when nothing changed;
 *   - a draft cannot be queued once its ARIA action is closed;
 *   - schedule conflicts reconcile and recur through the real generator;
 *   - the confirmation-gap generator is dormant (documented, not silently "active").
 */

const state: { db: FakeSupabase } = { db: new FakeSupabase() };

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-a", studioRole: "studio_owner", userId: "owner" }),
}));

const A = "studio-a";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return new FakeSupabase({
    studios: [{ id: A, name: "Studio A", public_name: null, slug: "studio-a", public_logo_url: null, timezone: "America/New_York" }],
    profiles: [{ id: "owner", full_name: "Owner", email: "owner@example.test" }],
    clients: [{ id: "client-1", studio_id: A, first_name: "Robin", last_name: "Lee", email: "robin@example.test", status: "lead", created_at: at(-200) }],
    lead_activities: [{ id: "la-1", studio_id: A, client_id: "client-1", created_at: at(-1), follow_up_due_at: null, completed_at: null }],
    automation_actions: [],
    automation_action_events: [],
    outbound_deliveries: [],
    aria_digest_runs: [],
    ...extra,
  });
}

async function actions() {
  return import("@/app/app/automations/actions");
}

async function scheduledRun() {
  const { runScheduledAriaOperationsForStudio } = await actions();
  return runScheduledAriaOperationsForStudio({ studioId: A, actorUserId: "owner", includeStudioSignals: true, includeOrganizerSignals: false });
}

async function briefing() {
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
  return state.db.rows("aria_digest_runs").at(-1)!.summary as {
    open_actions: number;
    queued_followups: number;
    top_actions: Array<{ id: string; title: string }>;
  };
}

const lowPackage = () => ({
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
  client_package_items: [{ client_package_id: "pkg-old", studio_id: A, usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("queued actions in the Morning Briefing", () => {
  it("generated -> approved -> queued -> source changes: briefing reports execution status only, delivery untouched, no duplicate", async () => {
    state.db = seed(lowPackage());
    await scheduledRun(); // default policy: auto-approve + auto-send -> queued with an outbound delivery
    const [action] = state.db.rows("automation_actions").filter((row) => row.rule_key === "aria_low_package_balance");
    expect(action.status).toBe("queued");
    const [delivery] = state.db.rows("outbound_deliveries");
    expect(delivery.status).toBe("queued");
    const deliverySnapshot = { ...delivery };

    // the client renews elsewhere: the stored "1 credit remaining" wording is no longer true
    state.db.rows("client_packages").push({
      id: "pkg-new",
      studio_id: A,
      client_id: "client-1",
      name_snapshot: "Starter 10",
      active: true,
      expiration_date: null,
      client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 10, is_unlimited: false }],
    });
    state.db.rows("client_package_items").push({ client_package_id: "pkg-new", studio_id: A, usage_type: "private_lesson", quantity_remaining: 10, is_unlimited: false });

    const summary = await briefing();
    expect(summary.top_actions.map((item) => item.id)).not.toContain(action.id);
    expect(summary.open_actions).toBe(0);
    expect(summary.queued_followups).toBe(1);

    // outbound payload and the queued action are untouched; delivery/outcome lifecycle unchanged
    expect(state.db.rows("outbound_deliveries")).toEqual([deliverySnapshot]);
    expect(action.status).toBe("queued");

    // no duplicate action from later runs
    await scheduledRun();
    expect(state.db.rows("automation_actions").filter((row) => row.rule_key === "aria_low_package_balance")).toHaveLength(1);
  });
});

describe("page-load wording refresh (Operations Center / Opportunity Hub)", () => {
  const writes = () => state.db.operations.filter((operation) => ["insert", "update", "upsert", "delete"].includes(operation.op));

  it("refreshes stale wording immediately, creates/approves/assigns/sends nothing, and is write-free on repeat", async () => {
    state.db = seed({
      commerce_product_variant_inventory: [
        { id: "inv-1", studio_id: A, catalog_item_id: null, name: "Practice shoes", quantity_on_hand: 1, reorder_threshold: 3, active: true },
      ],
      aria_action_policies: [
        { studio_id: A, rule_key: "aria_inventory_low_stock", pack_key: "retail_inventory", enabled: true, auto_approve: true, max_auto_approve_priority: "urgent", default_assigned_to: "owner" },
      ],
      automation_actions: [
        {
          id: "stock",
          studio_id: A,
          rule_key: "aria_inventory_low_stock",
          related_table: "commerce_product_variant_inventory",
          related_id: "inv-1",
          status: "suggested",
          title: "Low stock: Practice shoes",
          body: "Practice shoes has 3 on hand with a reorder threshold of 3. Review recent sales and pending replenishment before placing an order.",
          priority: "high",
          assigned_to: null,
          created_at: at(-1),
        },
      ],
    });
    const { refreshAriaActionWordingForStudio } = await actions();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshAriaActionWordingForStudio({ studioId: A, supabase: state.db as any, workspace: "studio" });

    const stock = state.db.rows("automation_actions").find((row) => row.id === "stock")!;
    expect(String(stock.body)).toContain("has 1 on hand");
    expect(stock.status).toBe("suggested"); // not approved despite the auto-approve policy
    expect(stock.assigned_to).toBeNull(); // not assigned despite the default assignee
    expect(state.db.rows("automation_actions")).toHaveLength(1); // nothing created
    expect(state.db.rows("automation_action_events")).toHaveLength(0);
    expect(state.db.rows("outbound_deliveries")).toHaveLength(0);
    expect(writes().every((operation) => operation.op === "update" && operation.table === "automation_actions")).toBe(true);

    state.db.operations = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await refreshAriaActionWordingForStudio({ studioId: A, supabase: state.db as any, workspace: "studio" });
    expect(writes()).toHaveLength(0);
  });

  it("both pages refresh, then reconcile, before their first action read", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of ["src/app/app/aria/operations/page.tsx", "src/app/app/aria/page.tsx"]) {
      const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const refresh = source.indexOf("await refreshAriaActionWordingForStudio({");
      const reconcile = source.indexOf("await reconcileAriaActionsForStudio({ supabase, studioId });");
      const firstRead = source.indexOf('.from("automation_actions")');
      expect(refresh).toBeGreaterThan(-1);
      expect(refresh).toBeLessThan(reconcile);
      expect(reconcile).toBeLessThan(firstRead);
      expect(source).toContain('workspace: organizerWorkspace ? "organizer" : "studio"');
    }
  });
});

describe("email drafts of closed actions cannot be queued", () => {
  function draftDb(actionStatus: string) {
    return seed({
      automation_actions: [
        { id: "act-1", studio_id: A, rule_key: "low_package_balance", related_table: "client_packages", related_id: "pkg-old", status: actionStatus, created_at: at(-2) },
        { id: "act-2", studio_id: A, rule_key: "low_package_balance", related_table: "client_packages", related_id: "pkg-2", status: "drafted", created_at: at(-2) },
      ],
      outbound_deliveries: [
        { id: "d-1", studio_id: A, related_table: "automation_actions", related_id: "act-1", status: "draft", recipient_email: "robin@example.test", subject: "Renewal", body_text: "You have 1 credit left." },
        { id: "d-2", studio_id: A, related_table: "automation_actions", related_id: "act-2", status: "draft", recipient_email: "robin@example.test", subject: "Renewal", body_text: "You have 1 credit left." },
      ],
    });
  }

  it("single queue: a completed action's draft is refused and stays a draft; an open action's draft queues", async () => {
    state.db = draftDb("completed");
    const { queueAutomationEmailDraftAction } = await actions();
    const closed = new FormData();
    closed.set("actionId", "act-1");
    closed.set("deliveryId", "d-1");
    await expect(queueAutomationEmailDraftAction(closed)).rejects.toThrow("draft-action-closed");
    expect(state.db.rows("outbound_deliveries").find((row) => row.id === "d-1")!.status).toBe("draft");

    const open = new FormData();
    open.set("actionId", "act-2");
    open.set("deliveryId", "d-2");
    await expect(queueAutomationEmailDraftAction(open)).rejects.toThrow(/redirect:/);
    expect(state.db.rows("outbound_deliveries").find((row) => row.id === "d-2")!.status).toBe("queued");
  });

  it("batch queue skips drafts whose action is closed", async () => {
    state.db = draftDb("dismissed");
    const { queueSelectedAutomationEmailDraftsAction } = await actions();
    const form = new FormData();
    form.append("deliveryIds", "d-1");
    form.append("deliveryIds", "d-2");
    await expect(queueSelectedAutomationEmailDraftsAction(form)).rejects.toThrow(/queued=1&skipped=1/);
    expect(state.db.rows("outbound_deliveries").find((row) => row.id === "d-1")!.status).toBe("draft");
    expect(state.db.rows("outbound_deliveries").find((row) => row.id === "d-2")!.status).toBe("queued");
  });
});

describe("aria_schedule_conflict through the real generator", () => {
  const lesson = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    studio_id: A,
    client_id: null,
    instructor_id: "inst-1",
    room_id: "room-1",
    appointment_type: "private_lesson",
    status: "scheduled",
    starts_at: at(2),
    ends_at: new Date(new Date(at(2)).getTime() + 60 * 60 * 1000).toISOString(),
    payment_status: "paid",
    price_amount: 0,
    ...fields,
  });

  it("conflict -> action; resolved -> completed and not recreated; genuine recurrence -> new action", async () => {
    state.db = seed({ appointments: [lesson("a1"), lesson("a2")] });
    await scheduledRun();
    const conflicts = () => state.db.rows("automation_actions").filter((row) => row.rule_key === "aria_schedule_conflict");
    expect(conflicts()).toHaveLength(1);

    // the second lesson moves to another instructor and room
    Object.assign(state.db.rows("appointments").find((row) => row.id === "a2")!, { instructor_id: "inst-2", room_id: "room-2" });
    await scheduledRun();
    await scheduledRun();
    expect(conflicts().map((row) => row.status)).toEqual(["completed"]);

    // a new booking collides with the same anchor later
    state.db.rows("appointments").push(lesson("a3"));
    await scheduledRun();
    expect(conflicts().map((row) => row.status).sort()).toEqual(["completed", "suggested"]);
  });
});

describe("aria_appointment_confirmation_gap is dormant", () => {
  it("an unconfirmed (scheduled) lesson starting within 24 hours does not create a confirmation-gap action", async () => {
    state.db = seed({
      appointments: [
        { id: "soon", studio_id: A, client_id: "client-1", instructor_id: "inst-1", room_id: null, appointment_type: "private_lesson", status: "scheduled", starts_at: at(0.5), ends_at: at(0.55), payment_status: "paid", price_amount: 0 },
      ],
    });
    await scheduledRun();
    expect(state.db.rows("automation_actions").filter((row) => row.rule_key === "aria_appointment_confirmation_gap")).toHaveLength(0);
  });
});
