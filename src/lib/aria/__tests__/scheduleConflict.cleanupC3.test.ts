import { describe, expect, it } from "vitest";
import { reconcileAriaActionsForStudio } from "@/lib/aria/actionReconciliation";
import { FakeSupabase } from "./fakeSupabase";

/**
 * Cleanup PR C3: aria_schedule_conflict is anchored to one appointment of an overlapping pair. Reconciliation never
 * guesses the other appointment: it closes only when the anchor has NO remaining conflict (generator definition), and
 * stays open while any conflict remains.
 */

const A = "studio-a";
const B = "studio-b";
const NOW = new Date("2026-10-08T15:00:00.000Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

function appt(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    studio_id: A,
    status: "scheduled",
    instructor_id: "inst-1",
    room_id: "room-1",
    starts_at: hours(24),
    ends_at: hours(25),
    ...fields,
  };
}

function db(appointments: Record<string, unknown>[], actionStatus = "suggested") {
  return new FakeSupabase({
    appointments,
    automation_actions: [
      {
        id: "act",
        studio_id: A,
        rule_key: "aria_schedule_conflict",
        related_table: "appointments",
        related_id: "anchor",
        status: actionStatus,
        body: "Two upcoming appointments overlap.",
        created_at: hours(-2),
      },
    ],
    automation_action_events: [],
  });
}

function run(store: FakeSupabase, now = NOW) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return reconcileAriaActionsForStudio({ supabase: store as any, studioId: A, now });
}

const status = (store: FakeSupabase) => store.rows("automation_actions")[0].status;

describe("aria_schedule_conflict reconciliation", () => {
  it("stays open while the anchor still overlaps another appointment for the same instructor", async () => {
    const store = db([appt("anchor"), appt("other", { room_id: "room-2", starts_at: hours(24.5), ends_at: hours(25.5) })]);
    await run(store);
    expect(status(store)).toBe("suggested");
    expect(store.rows("automation_action_events")).toHaveLength(0);
  });

  it("completes once the overlap is gone (other appointment moved), exactly once", async () => {
    const store = db([appt("anchor"), appt("other", { starts_at: hours(26), ends_at: hours(27) })]);
    await run(store);
    expect(status(store)).toBe("completed");
    await run(store);
    expect(store.rows("automation_action_events")).toHaveLength(1);
    expect(store.rows("automation_action_events")[0].metadata).toMatchObject({ reason: "conflict_cleared", source: "aria_condition_reconciliation" });
  });

  it("completes when the other appointment was reassigned to a different instructor and room", async () => {
    const store = db([appt("anchor"), appt("other", { instructor_id: "inst-2", room_id: "room-2" })]);
    await run(store);
    expect(status(store)).toBe("completed");
  });

  it("completes when the other appointment was cancelled", async () => {
    const store = db([appt("anchor"), appt("other", { status: "cancelled" })]);
    await run(store);
    expect(status(store)).toBe("completed");
  });

  it("ambiguous: one of two conflicting appointments resolved, the other still conflicts -> stays open (no pair guessing)", async () => {
    const store = db([
      appt("anchor"),
      appt("original", { status: "cancelled" }),
      appt("another", { room_id: "room-9", starts_at: hours(24.25), ends_at: hours(24.75) }),
    ]);
    await run(store);
    expect(status(store)).toBe("suggested");
  });

  it("anchor cancelled -> completed; anchor started -> expired (skipped)", async () => {
    const cancelled = db([appt("anchor", { status: "cancelled" }), appt("other")]);
    await run(cancelled);
    expect(status(cancelled)).toBe("completed");

    const started = db([appt("anchor", { starts_at: hours(1), ends_at: hours(2) }), appt("other", { starts_at: hours(1.5), ends_at: hours(2.5) })]);
    await run(started, new Date(new Date(hours(1)).getTime() - 1));
    expect(status(started)).toBe("suggested");
    await run(started, new Date(hours(1)));
    expect(status(started)).toBe("skipped");
  });

  it("missing anchor fails closed", async () => {
    const store = db([appt("other")]);
    await run(store);
    expect(status(store)).toBe("suggested");
  });

  it("another studio's appointments neither keep it open nor resolve it", async () => {
    // only conflicting appointment belongs to studio B -> studio A's anchor has no conflict in its own studio
    const store = db([appt("anchor"), appt("other-b", { studio_id: B })]);
    await run(store);
    expect(status(store)).toBe("completed");

    // anchor itself in studio B: invisible to studio A -> ambiguous, untouched
    const foreign = db([appt("anchor", { studio_id: B })]);
    await run(foreign);
    expect(status(foreign)).toBe("suggested");
  });

  it("queued conflict actions are never touched", async () => {
    const store = db([appt("anchor")], "queued");
    await run(store);
    expect(status(store)).toBe("queued");
  });
});

describe("aria_appointment_confirmation_gap handler follows the real confirmation model", () => {
  it("a rescheduled appointment still awaits confirmation (stays open); confirmed completes", async () => {
    const store = new FakeSupabase({
      appointments: [{ id: "a1", studio_id: A, status: "rescheduled", starts_at: hours(5) }],
      automation_actions: [
        { id: "act", studio_id: A, rule_key: "aria_appointment_confirmation_gap", related_table: "appointments", related_id: "a1", status: "suggested", created_at: hours(-1) },
      ],
      automation_action_events: [],
    });
    await run(store);
    expect(status(store)).toBe("suggested");
    store.rows("appointments")[0].status = "confirmed";
    await run(store);
    expect(status(store)).toBe("completed");
  });
});
