import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "@/lib/aria/__tests__/fakeSupabase";

/**
 * Cleanup PR C: a dismissed/completed ARIA action is not bypassed by inserting a replacement for the SAME continuous
 * incident on the next run; a genuinely NEW occurrence may still create a new action. Exercised end to end through the
 * real scheduled ARIA run against an in-memory database.
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
const NOW = new Date("2026-10-08T15:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

function seed(extra: Record<string, Record<string, unknown>[]>) {
  return new FakeSupabase({
    studios: [{ id: A, name: "Studio A", public_name: null, slug: "studio-a", public_logo_url: null }],
    clients: [
      // no email: nothing is ever sent, so action states stay easy to read
      { id: "client-1", studio_id: A, first_name: "Robin", last_name: "Lee", email: null, status: "lead", created_at: ago(200) },
    ],
    // a recorded activity keeps unrelated lead rules quiet
    lead_activities: [{ id: "la-1", studio_id: A, client_id: "client-1", created_at: ago(1), follow_up_due_at: null, completed_at: null }],
    automation_actions: [],
    automation_action_events: [],
    outbound_deliveries: [],
    ...extra,
  });
}

async function scheduledRun() {
  const { runScheduledAriaOperationsForStudio } = await import("@/app/app/automations/actions");
  return runScheduledAriaOperationsForStudio({
    studioId: A,
    actorUserId: "user-owner",
    includeStudioSignals: true,
    includeOrganizerSignals: false,
  });
}

function actionsFor(ruleKey: string) {
  return state.db.rows("automation_actions").filter((row) => row.rule_key === ruleKey);
}

function staffDismiss(row: Record<string, unknown>) {
  Object.assign(row, { status: "dismissed", dismissed_at: new Date().toISOString(), dismissed_by: "user-owner" });
}

async function createThenDismiss(ruleKey: string) {
  await scheduledRun();
  const created = actionsFor(ruleKey);
  expect(created).toHaveLength(1);
  staffDismiss(created[0]);
  return created[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("aria_payment_exception (incident = the payment)", () => {
  it("the same failed payment does not regenerate after dismissal; a later failed payment does", async () => {
    state.db = seed({
      payments: [{ id: "pay-1", studio_id: A, client_id: "client-1", status: "failed", amount: 50, payment_type: "lesson", created_at: ago(2) }],
    });
    const dismissed = await createThenDismiss("aria_payment_exception");

    await scheduledRun();
    await scheduledRun();
    expect(actionsFor("aria_payment_exception")).toHaveLength(1);
    expect(dismissed.status).toBe("dismissed");

    // a NEW payment fails later: new incident
    state.db.rows("payments").push({ id: "pay-2", studio_id: A, client_id: "client-1", status: "failed", amount: 50, payment_type: "lesson", created_at: ago(0) });
    await scheduledRun();
    const rows = actionsFor("aria_payment_exception");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.related_id === "pay-2")?.status).not.toBe("dismissed");
  });

  it("after the system observed the payment clear, the same payment failing again is a new occurrence", async () => {
    state.db = seed({
      payments: [{ id: "pay-1", studio_id: A, client_id: "client-1", status: "failed", amount: 50, payment_type: "lesson", created_at: ago(2) }],
    });
    await scheduledRun();
    state.db.rows("payments")[0].status = "paid";
    await scheduledRun(); // reconciled -> completed by the system
    expect(actionsFor("aria_payment_exception")[0].status).toBe("completed");

    state.db.rows("payments")[0].status = "failed";
    await scheduledRun();
    expect(actionsFor("aria_payment_exception")).toHaveLength(2);
  });
});

describe("aria_booking_request_aging (incident = the request)", () => {
  it("request A does not regenerate after dismissal; request B aging later does", async () => {
    state.db = seed({
      booking_requests: [{ id: "br-a", studio_id: A, client_id: null, status: "pending", source: "portal", created_at: ago(5), requested_starts_at: ago(-3) }],
    });
    await createThenDismiss("aria_booking_request_aging");
    await scheduledRun();
    expect(actionsFor("aria_booking_request_aging")).toHaveLength(1);

    state.db.rows("booking_requests").push({ id: "br-b", studio_id: A, client_id: null, status: "pending", source: "portal", created_at: ago(4), requested_starts_at: ago(-5) });
    await scheduledRun();
    const rows = actionsFor("aria_booking_request_aging");
    expect(rows.map((row) => row.related_id).sort()).toEqual(["br-a", "br-b"]);
  });
});

describe("aria_membership_past_due (incident = the past-due billing episode)", () => {
  it("the same continuous past-due episode does not regenerate; a later episode after recovery does", async () => {
    state.db = seed({
      client_memberships: [
        { id: "mem-1", studio_id: A, client_id: "client-1", name_snapshot: "Monthly", status: "past_due", current_period_start: ago(10), current_period_end: ago(-20), cancel_at_period_end: false },
      ],
    });
    await createThenDismiss("aria_membership_past_due");
    await scheduledRun();
    await scheduledRun();
    expect(actionsFor("aria_membership_past_due")).toHaveLength(1);

    // back in good standing, then past due again in a later billing period
    const membership = state.db.rows("client_memberships")[0];
    membership.status = "active";
    await scheduledRun();
    vi.setSystemTime(new Date(NOW.getTime() + 31 * DAY));
    Object.assign(membership, { status: "past_due", current_period_start: new Date(NOW.getTime() + 30 * DAY).toISOString() });
    await scheduledRun();
    expect(actionsFor("aria_membership_past_due")).toHaveLength(2);
  });
});

describe("aria_external_payment_missing (incident = the appointment)", () => {
  it("the same unpaid appointment does not regenerate after dismissal", async () => {
    state.db = seed({
      appointments: [
        { id: "appt-1", studio_id: A, client_id: "client-1", instructor_id: "inst-1", appointment_type: "private_lesson", status: "scheduled", starts_at: ago(3), payment_status: "unpaid", price_amount: 80 },
      ],
    });
    await createThenDismiss("aria_external_payment_missing");
    await scheduledRun();
    await scheduledRun();
    expect(actionsFor("aria_external_payment_missing")).toHaveLength(1);
  });
});

describe("aria_intro_no_purchase (incident = the intro lesson without a purchase)", () => {
  it("the unchanged condition does not regenerate after dismissal; a newer intro lesson is a new occurrence", async () => {
    state.db = seed({
      appointments: [
        { id: "intro-1", studio_id: A, client_id: "client-1", instructor_id: "inst-1", appointment_type: "intro_lesson", status: "attended", starts_at: ago(10), payment_status: "paid", price_amount: 0 },
      ],
    });
    await createThenDismiss("aria_intro_no_purchase");
    await scheduledRun();
    await scheduledRun();
    expect(actionsFor("aria_intro_no_purchase")).toHaveLength(1);

    // a second intro lesson completed after the dismissed action, still no purchase
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY));
    state.db.rows("appointments").push({
      id: "intro-2",
      studio_id: A,
      client_id: "client-1",
      instructor_id: "inst-1",
      appointment_type: "intro_lesson",
      status: "attended",
      starts_at: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      payment_status: "paid",
      price_amount: 0,
    });
    await scheduledRun();
    expect(actionsFor("aria_intro_no_purchase")).toHaveLength(2);
  });
});

describe("in-flight incidents", () => {
  it("an awaiting_outcome action for the same incident is not duplicated", async () => {
    state.db = seed({
      payments: [{ id: "pay-1", studio_id: A, client_id: "client-1", status: "failed", amount: 50, payment_type: "lesson", created_at: ago(2) }],
      automation_actions: [
        {
          id: "in-flight",
          studio_id: A,
          rule_key: "aria_payment_exception",
          related_table: "payments",
          related_id: "pay-1",
          status: "awaiting_outcome",
          created_at: ago(1),
        },
      ],
    });
    await scheduledRun();
    expect(actionsFor("aria_payment_exception")).toHaveLength(1);
  });
});
