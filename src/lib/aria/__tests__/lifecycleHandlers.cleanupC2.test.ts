import { describe, expect, it } from "vitest";
import { ARIA_LIFECYCLE_RULE_KEYS, reconcileAriaActionsForStudio } from "@/lib/aria/actionReconciliation";
import { ariaLowCheckinBody } from "@/lib/aria/lifecycleHandlers";
import { FakeSupabase } from "./fakeSupabase";

/**
 * Cleanup PR C2: current-state handlers for the remaining ARIA opportunity types. Every case runs the same checks:
 * still true -> open; resolved -> closed (completed / skipped) or wording superseded; missing source -> untouched;
 * another studio's data -> untouched; replay -> no further change and exactly one lifecycle event.
 */

const A = "studio-a";
const B = "studio-b";
const NOW = new Date("2026-10-08T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

type Rows = Record<string, Record<string, unknown>[]>;
type Case = {
  rule: string;
  relatedTable: string;
  relatedId: string;
  body?: string;
  source: () => Rows; // still-true state (source rows for studio A)
  resolve: (db: FakeSupabase) => void;
  expected: "completed" | "skipped" | "refresh";
};

function find(db: FakeSupabase, table: string, id: string) {
  return db.rows(table).find((row) => row.id === id)!;
}

const event = (fields: Record<string, unknown> = {}) => ({
  id: "ev-1",
  studio_id: A,
  name: "Spring Social",
  status: "published",
  start_date: "2026-10-20",
  start_time: "19:00:00",
  end_date: "2026-10-20",
  end_time: "22:00:00",
  timezone: "America/New_York",
  capacity: 20,
  ...fields,
});

const CASES: Case[] = [
  {
    rule: "aria_document_expiration",
    relatedTable: "document_assignments",
    relatedId: "doc-1",
    source: () => ({ document_assignments: [{ id: "doc-1", studio_id: A, status: "pending", due_at: at(-2) }] }),
    resolve: (db) => (find(db, "document_assignments", "doc-1").status = "signed"),
    expected: "completed",
  },
  {
    rule: "unsigned_document",
    relatedTable: "document_assignments",
    relatedId: "doc-1",
    source: () => ({ document_assignments: [{ id: "doc-1", studio_id: A, status: "pending", due_at: at(2) }] }),
    resolve: (db) => (find(db, "document_assignments", "doc-1").status = "waived"),
    expected: "completed",
  },
  {
    rule: "aria_order_fulfillment_exception",
    relatedTable: "commerce_orders",
    relatedId: "ord-1",
    source: () => ({ commerce_orders: [{ id: "ord-1", studio_id: A, status: "open", fulfillment_status: "unfulfilled" }] }),
    resolve: (db) => (find(db, "commerce_orders", "ord-1").fulfillment_status = "fulfilled"),
    expected: "completed",
  },
  {
    rule: "aria_event_unpaid_registration",
    relatedTable: "event_registrations",
    relatedId: "reg-1",
    source: () => ({ event_registrations: [{ id: "reg-1", studio_id: A, status: "pending", payment_status: "pending" }] }),
    resolve: (db) => (find(db, "event_registrations", "reg-1").payment_status = "paid"),
    expected: "completed",
  },
  {
    rule: "aria_instructor_coverage_gap",
    relatedTable: "appointments",
    relatedId: "appt-1",
    source: () => ({ appointments: [{ id: "appt-1", studio_id: A, status: "scheduled", instructor_id: null, starts_at: at(3) }] }),
    resolve: (db) => (find(db, "appointments", "appt-1").instructor_id = "inst-1"),
    expected: "completed",
  },
  {
    rule: "aria_lead_follow_up_sequence",
    relatedTable: "lead_activities",
    relatedId: "la-1",
    source: () => ({ lead_activities: [{ id: "la-1", studio_id: A, client_id: "c-1", completed_at: null, follow_up_due_at: at(-1) }] }),
    resolve: (db) => (find(db, "lead_activities", "la-1").completed_at = at(0)),
    expected: "completed",
  },
  {
    rule: "aria_staff_task_reminder",
    relatedTable: "lead_activities",
    relatedId: "la-1",
    source: () => ({ lead_activities: [{ id: "la-1", studio_id: A, client_id: "c-1", completed_at: null, follow_up_due_at: at(-1) }] }),
    resolve: (db) => (find(db, "lead_activities", "la-1").follow_up_due_at = at(2)),
    expected: "completed",
  },
  {
    rule: "aria_lead_acknowledgement",
    relatedTable: "clients",
    relatedId: "c-1",
    source: () => ({ clients: [{ id: "c-1", studio_id: A, status: "lead" }], lead_activities: [] }),
    resolve: (db) => db.rows("lead_activities").push({ id: "la-9", studio_id: A, client_id: "c-1" }),
    expected: "completed",
  },
  {
    rule: "aria_inventory_low_stock",
    relatedTable: "commerce_product_variant_inventory",
    relatedId: "inv-1",
    source: () => ({
      commerce_product_variant_inventory: [{ id: "inv-1", studio_id: A, active: true, quantity_on_hand: 1, reorder_threshold: 3 }],
    }),
    resolve: (db) => (find(db, "commerce_product_variant_inventory", "inv-1").quantity_on_hand = 12),
    expected: "completed",
  },
  {
    rule: "aria_payroll_missing_data",
    relatedTable: "instructors",
    relatedId: "inst-1",
    source: () => ({
      instructors: [{ id: "inst-1", studio_id: A, active: true }],
      instructor_payroll_profiles: [{ id: "pp-1", studio_id: A, instructor_id: "inst-1", payroll_active: true, worker_classification: null }],
      instructor_compensation_rules: [],
    }),
    resolve: (db) => {
      find(db, "instructor_payroll_profiles", "pp-1").worker_classification = "w2";
      db.rows("instructor_compensation_rules").push({ id: "cr-1", studio_id: A, instructor_id: "inst-1" });
    },
    expected: "completed",
  },
  {
    rule: "aria_event_missing_costs",
    relatedTable: "events",
    relatedId: "ev-1",
    source: () => ({
      events: [event()],
      v_event_profit_loss: [{ event_id: "ev-1", net_ticket_revenue: 500, event_profit_loss: 500, event_expenses: 0, event_labor_costs: 0 }],
    }),
    resolve: (db) => Object.assign(db.rows("v_event_profit_loss")[0], { event_expenses: 50, event_labor_costs: 80 }),
    expected: "completed",
  },
  {
    rule: "aria_student_app_adoption",
    relatedTable: "clients",
    relatedId: "c-1",
    source: () => ({ clients: [{ id: "c-1", studio_id: A, status: "active", email: "a@example.test" }], client_account_links: [] }),
    resolve: (db) => db.rows("client_account_links").push({ id: "l-1", studio_id: A, client_id: "c-1", status: "linked" }),
    expected: "completed",
  },
  {
    rule: "pending_booking_request",
    relatedTable: "booking_requests",
    relatedId: "br-1",
    source: () => ({ booking_requests: [{ id: "br-1", studio_id: A, status: "pending" }] }),
    resolve: (db) => (find(db, "booking_requests", "br-1").status = "approved"),
    expected: "completed",
  },
  {
    rule: "aria_appointment_confirmation_gap",
    relatedTable: "appointments",
    relatedId: "appt-1",
    source: () => ({ appointments: [{ id: "appt-1", studio_id: A, status: "scheduled", starts_at: at(0.5) }] }),
    resolve: (db) => (find(db, "appointments", "appt-1").status = "confirmed"),
    expected: "completed",
  },
  {
    rule: "aria_event_promotion_gap",
    relatedTable: "events",
    relatedId: "ev-1",
    source: () => ({ events: [event()], event_registrations: [{ id: "r1", studio_id: A, event_id: "ev-1", status: "confirmed", quantity: 2 }] }),
    resolve: (db) => db.rows("event_registrations").push({ id: "r2", studio_id: A, event_id: "ev-1", status: "confirmed", quantity: 3 }),
    expected: "completed",
  },
  {
    rule: "aria_class_capacity",
    relatedTable: "events",
    relatedId: "ev-1",
    source: () => ({ events: [event({ start_date: "2026-10-08", start_time: "18:00:00" })] }), // 22:00Z today
    resolve: (db) => (find(db, "events", "ev-1").start_time = "10:00:00"), // 14:00Z -> already started
    expected: "skipped",
  },
  {
    rule: "aria_cancellation_follow_up",
    relatedTable: "appointments",
    relatedId: "appt-x",
    source: () => ({ appointments: [{ id: "appt-x", studio_id: A, client_id: "c-1", status: "cancelled", starts_at: at(-1) }] }),
    resolve: (db) => db.rows("appointments").push({ id: "appt-new", studio_id: A, client_id: "c-1", status: "scheduled", starts_at: at(5) }),
    expected: "completed",
  },
  {
    rule: "aria_membership_canceling",
    relatedTable: "client_memberships",
    relatedId: "mem-1",
    source: () => ({ client_memberships: [{ id: "mem-1", studio_id: A, status: "active", cancel_at_period_end: true }] }),
    resolve: (db) => (find(db, "client_memberships", "mem-1").cancel_at_period_end = false),
    expected: "completed",
  },
  {
    rule: "aria_stale_active_student",
    relatedTable: "clients",
    relatedId: "c-1",
    source: () => ({ clients: [{ id: "c-1", studio_id: A, status: "active" }], appointments: [] }),
    resolve: (db) => db.rows("appointments").push({ id: "f-1", studio_id: A, client_id: "c-1", status: "scheduled", starts_at: at(4) }),
    expected: "completed",
  },
  {
    rule: "no_upcoming_lesson",
    relatedTable: "clients",
    relatedId: "c-1",
    source: () => ({ clients: [{ id: "c-1", studio_id: A, status: "active" }], appointments: [], booking_requests: [] }),
    resolve: (db) => db.rows("booking_requests").push({ id: "br-9", studio_id: A, client_id: "c-1", status: "pending" }),
    expected: "completed",
  },
  {
    rule: "first_lesson_follow_up",
    relatedTable: "appointments",
    relatedId: "first",
    source: () => ({ appointments: [{ id: "first", studio_id: A, client_id: "c-1", status: "attended", starts_at: at(-5) }] }),
    resolve: (db) => db.rows("appointments").push({ id: "second", studio_id: A, client_id: "c-1", status: "scheduled", starts_at: at(2) }),
    expected: "completed",
  },
  {
    rule: "aria_event_loss",
    relatedTable: "events",
    relatedId: "ev-1",
    body: "Spring Social is currently below break-even. Review refunds, fees, labor, expenses, and pricing before repeating the format.",
    source: () => ({ events: [event()], v_event_profit_loss: [{ event_id: "ev-1", event_profit_loss: -500 }] }),
    resolve: (db) => (db.rows("v_event_profit_loss")[0].event_profit_loss = 50),
    expected: "refresh",
  },
  {
    rule: "aria_data_quality_exception",
    relatedTable: "import_batches",
    relatedId: "ib-1",
    body: "Legacy clients batch has status failed with 3 failed rows. Review the batch before treating migrated records as complete.",
    source: () => ({
      import_batches: [{ id: "ib-1", studio_id: A, source_system: "Legacy", import_type: "clients", status: "failed", failed_rows: 3 }],
    }),
    resolve: (db) => Object.assign(find(db, "import_batches", "ib-1"), { status: "completed", failed_rows: 0 }),
    expected: "refresh",
  },
  {
    rule: "aria_no_show_service_recovery",
    relatedTable: "appointments",
    relatedId: "appt-1",
    source: () => ({ appointments: [{ id: "appt-1", studio_id: A, status: "no_show", starts_at: at(-1) }] }),
    resolve: (db) => (find(db, "appointments", "appt-1").status = "attended"),
    expected: "completed",
  },
  {
    rule: "aria_marketing_opportunity",
    relatedTable: "marketing_campaigns",
    relatedId: "mc-1",
    source: () => ({ marketing_campaigns: [{ id: "mc-1", studio_id: A, status: "draft" }] }),
    resolve: (db) => (find(db, "marketing_campaigns", "mc-1").status = "sent"),
    expected: "completed",
  },
  {
    rule: "aria_inactive_client_reactivation",
    relatedTable: "clients",
    relatedId: "c-1",
    source: () => ({ clients: [{ id: "c-1", studio_id: A, status: "inactive" }], appointments: [] }),
    resolve: (db) => (find(db, "clients", "c-1").status = "active"),
    expected: "completed",
  },
  {
    rule: "aria_event_low_checkin",
    relatedTable: "events",
    relatedId: "ev-1",
    body: ariaLowCheckinBody("Spring Social", 0.2),
    source: () => ({
      events: [event({ start_date: "2026-10-01" })],
      event_registrations: [],
      event_registration_attendees: Array.from({ length: 10 }, (_, index) => ({
        id: `t${index}`,
        event_id: "ev-1",
        checked_in_at: index < 2 ? at(-7) : null,
      })),
    }),
    resolve: (db) => db.rows("event_registration_attendees").forEach((row, index) => index < 8 && (row.checked_in_at = at(-7))),
    expected: "completed",
  },
];

function buildDb(testCase: Case, sourceStudio = A, withSource = true) {
  const rows: Rows = withSource ? testCase.source() : {};
  if (sourceStudio !== A) {
    for (const list of Object.values(rows)) for (const row of list) if ("studio_id" in row) row.studio_id = sourceStudio;
  }
  return new FakeSupabase({
    ...rows,
    automation_actions: [
      {
        id: "act",
        studio_id: A,
        rule_key: testCase.rule,
        related_table: testCase.relatedTable,
        related_id: testCase.relatedId,
        status: "suggested",
        body: testCase.body ?? "stored wording",
        created_at: at(-1),
      },
    ],
    automation_action_events: [],
  });
}

function run(db: FakeSupabase, now = NOW) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return reconcileAriaActionsForStudio({ supabase: db as any, studioId: A, now });
}

const action = (db: FakeSupabase) => db.rows("automation_actions")[0];

describe("every remaining rule except the deferred schedule conflict has a current-state handler", () => {
  it("registry coverage", () => {
    const covered = new Set(ARIA_LIFECYCLE_RULE_KEYS);
    for (const testCase of CASES) expect(covered.has(testCase.rule)).toBe(true);
    expect(covered.has("aria_schedule_conflict")).toBe(false);
    expect(covered.size).toBe(34);
  });
});

describe.each(CASES)("$rule", (testCase) => {
  it("condition still true -> stays open (wording untouched when nothing changed)", async () => {
    const db = buildDb(testCase);
    if (testCase.rule === "aria_event_low_checkin") {
      await run(db);
      expect(action(db).status).toBe("suggested");
      expect(action(db).body).toBe(ariaLowCheckinBody("Spring Social", 0.2));
      return;
    }
    await run(db);
    expect(action(db).status).toBe("suggested");
    expect(action(db).body).toBe(testCase.body ?? "stored wording");
    expect(db.rows("automation_action_events")).toHaveLength(0);
  });

  it(`resolved -> ${testCase.expected}, once, and replay changes nothing`, async () => {
    const db = buildDb(testCase);
    testCase.resolve(db);
    await run(db);
    if (testCase.expected === "refresh") {
      expect(action(db).status).toBe("suggested");
      expect(action(db).body).not.toBe(testCase.body);
      expect(db.rows("automation_action_events")).toHaveLength(0);
    } else {
      expect(action(db).status).toBe(testCase.expected);
      const events = db.rows("automation_action_events");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: testCase.expected, new_status: testCase.expected });
      expect(events[0].metadata).toMatchObject({ source: "aria_condition_reconciliation", rule_key: testCase.rule });
    }
    const snapshot = { ...action(db) };
    await run(db);
    expect(action(db)).toEqual(snapshot);
    expect(db.rows("automation_action_events")).toHaveLength(testCase.expected === "refresh" ? 0 : 1);
  });

  it("missing source data fails closed", async () => {
    const db = buildDb(testCase, A, false);
    await run(db);
    expect(action(db).status).toBe("suggested");
    expect(action(db).body).toBe(testCase.body ?? "stored wording");
  });

  it("another studio's (resolved) data cannot resolve it", async () => {
    const db = buildDb(testCase, B);
    testCase.resolve(db);
    for (const list of Object.values(db.tables)) for (const row of list) if (row.studio_id === A && row.id !== "act") row.studio_id = B;
    await run(db);
    expect(action(db).status).toBe("suggested");
  });
});

describe("time-bound windows: immediately before and after expiry", () => {
  it("instructor coverage gap expires exactly at the appointment start", async () => {
    const start = new Date(NOW.getTime() + 60 * 60 * 1000);
    const db = new FakeSupabase({
      appointments: [{ id: "appt-1", studio_id: A, status: "scheduled", instructor_id: null, starts_at: start.toISOString() }],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_instructor_coverage_gap", related_table: "appointments", related_id: "appt-1", status: "approved", created_at: at(-1) },
      ],
      automation_action_events: [],
    });
    await run(db, new Date(start.getTime() - 1));
    expect(action(db).status).toBe("approved");
    await run(db, start);
    expect(action(db).status).toBe("skipped");
    expect(db.rows("automation_action_events")[0]).toMatchObject({ event_type: "skipped", previous_status: "approved" });
  });

  it("confirmation gap expires at the appointment start", async () => {
    const start = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    const db = new FakeSupabase({
      appointments: [{ id: "appt-1", studio_id: A, status: "scheduled", starts_at: start.toISOString() }],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_appointment_confirmation_gap", related_table: "appointments", related_id: "appt-1", status: "suggested", created_at: at(-1) },
      ],
      automation_action_events: [],
    });
    await run(db, new Date(start.getTime() - 1));
    expect(action(db).status).toBe("suggested");
    await run(db, new Date(start.getTime() + 1));
    expect(action(db).status).toBe("skipped");
  });

  it("promotion gap expires when the event starts in its own time zone", async () => {
    // 19:00 America/New_York on Oct 20 = 23:00Z
    const startUtc = new Date("2026-10-20T23:00:00.000Z");
    const db = new FakeSupabase({
      events: [event()],
      event_registrations: [],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_event_promotion_gap", related_table: "events", related_id: "ev-1", status: "suggested", created_at: at(-1) },
      ],
      automation_action_events: [],
    });
    await run(db, new Date(startUtc.getTime() - 1));
    expect(action(db).status).toBe("suggested");
    await run(db, startUtc);
    expect(action(db).status).toBe("skipped");
  });

  it("cancellation follow-up stops being 'recent' two days after the cancelled appointment", async () => {
    const start = new Date("2026-10-07T15:00:00.000Z");
    const db = new FakeSupabase({
      appointments: [{ id: "appt-x", studio_id: A, client_id: "c-1", status: "cancelled", starts_at: start.toISOString() }],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_cancellation_follow_up", related_table: "appointments", related_id: "appt-x", status: "suggested", created_at: at(-1) },
      ],
      automation_action_events: [],
    });
    const windowEnd = new Date(start.getTime() + 2 * DAY);
    await run(db, new Date(windowEnd.getTime() - 1));
    expect(action(db).status).toBe("suggested");
    await run(db, windowEnd);
    expect(action(db).status).toBe("skipped");
  });

  it("membership canceling: an ended membership closes the retention window (skipped)", async () => {
    const db = new FakeSupabase({
      client_memberships: [{ id: "mem-1", studio_id: A, status: "cancelled", cancel_at_period_end: true }],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_membership_canceling", related_table: "client_memberships", related_id: "mem-1", status: "snoozed", created_at: at(-1) },
      ],
      automation_action_events: [],
    });
    await run(db);
    expect(action(db).status).toBe("skipped");
  });
});

describe("refreshed wording replaces stale facts", () => {
  it("low check-in rate: the stored '20%' becomes the current '40%' while still below threshold", async () => {
    const db = buildDb(CASES.find((testCase) => testCase.rule === "aria_event_low_checkin")!);
    db.rows("event_registration_attendees").forEach((row, index) => index < 4 && (row.checked_in_at = at(-7)));
    await run(db);
    expect(action(db).status).toBe("suggested");
    expect(action(db).body).toContain("40%");
    expect(action(db).body).not.toContain("20%");
  });

  it("event loss: 'below break-even' is superseded with the current figure, never auto-completed", async () => {
    const db = buildDb(CASES.find((testCase) => testCase.rule === "aria_event_loss")!);
    db.rows("v_event_profit_loss")[0].event_profit_loss = 50;
    await run(db);
    expect(action(db).status).toBe("suggested");
    expect(action(db).body).toContain("no longer below break-even");
    expect(action(db).body).toContain("$50");
  });

  it("queued actions are never rewritten", async () => {
    const db = buildDb(CASES.find((testCase) => testCase.rule === "aria_event_loss")!);
    action(db).status = "queued";
    db.rows("v_event_profit_loss")[0].event_profit_loss = 50;
    await run(db);
    expect(action(db).body).toContain("currently below break-even");
  });
});
