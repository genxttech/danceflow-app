import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "../../../check-in/__tests__/fakeSupabase";

/**
 * CI-B: competition check-in reviewed for the same read-then-write pattern.
 *  - Participant arrival ("present") is compare-and-set: a repeated or
 *    concurrent mark keeps the first checked_in_at / checked_in_by.
 *  - Two desks starting the same registration batch at once end up on one
 *    session (the unique index picks the winner) instead of one failing.
 *  - Completing twice keeps the first completed_at / completed_by.
 */

const state: { db: FakeDb; userId: string } = { db: new FakeDb(), userId: "staff-1" };

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.db.client({ id: state.userId }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "studio-1",
    studioRole: "studio_admin",
    isPlatformAdmin: false,
    userId: state.userId,
  }),
}));

import {
  completeCompetitionCheckinAction,
  startCompetitionCheckinAction,
  updateCompetitionCheckinPresenceAction,
} from "../actions";

function seed() {
  return new FakeDb(
    {
      events: [{ id: "evt-c", studio_id: "studio-1", organizer_id: null }],
      event_competition_registration_carts: [{ id: "cart-1", event_id: "evt-c", order_id: "order-1" }],
      event_registrations: [{ id: "reg-c", event_id: "evt-c", order_id: "order-1" }],
      event_registration_attendees: [
        { id: "att-c1", registration_id: "reg-c", event_id: "evt-c", first_name: "Ana", last_name: "Lee", attendee_role: "dancer", sort_order: 1 },
      ],
      event_competition_checkin_sessions: [
        { id: "cs-1", event_id: "evt-c", registration_cart_id: null, registration_id: "reg-other", order_id: null, status: "in_progress" },
      ],
      event_competition_checkin_participants: [
        { id: "cp-1", event_id: "evt-c", checkin_session_id: "cs-1", registration_attendee_id: "att-x", presence_status: "not_arrived", waiver_status: "not_required", checked_in_at: null, checked_in_by: null },
      ],
    },
    [
      // event_competition_checkin_sessions_cart_uidx (20260621)
      {
        table: "event_competition_checkin_sessions",
        columns: ["registration_cart_id"],
        where: (row: Row) => row.registration_cart_id != null,
      },
    ],
  );
}

function form(values: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

async function redirectOf(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
    throw error;
  }
  throw new Error("expected the action to redirect");
}

const presence = (presenceStatus: string) =>
  updateCompetitionCheckinPresenceAction(
    form({ eventId: "evt-c", sessionId: "cs-1", participantId: "cp-1", presenceStatus }),
  );

beforeEach(() => {
  state.db = seed();
  state.userId = "staff-1";
});

describe("CI-B competition presence check-in", () => {
  it("keeps the first arrival when a participant is marked present twice", async () => {
    await presence("present");
    const first = { ...state.db.rows("event_competition_checkin_participants")[0] };

    state.userId = "staff-2";
    await new Promise((resolve) => setTimeout(resolve, 5));
    await presence("present");
    const after = state.db.rows("event_competition_checkin_participants")[0];

    expect(first.presence_status).toBe("present");
    expect(after.checked_in_by).toBe("staff-1");
    expect(after.checked_in_at).toBe(first.checked_in_at);
  });

  it("changes the participant once when two desks mark arrival concurrently", async () => {
    await Promise.all([presence("present"), presence("present")]);

    const participantUpdates = state.db.log.filter(
      (entry) => entry.table === "event_competition_checkin_participants" && entry.op === "update",
    );
    const sessionRecalcs = state.db.log.filter(
      (entry) => entry.table === "event_competition_checkin_sessions" && entry.op === "update",
    );
    expect(participantUpdates).toHaveLength(2);
    // Only the call that actually changed the row recalculates the session.
    expect(sessionRecalcs).toHaveLength(1);
    expect(state.db.rows("event_competition_checkin_participants")[0].presence_status).toBe("present");
  });

  it("still lets staff correct a participant back to not arrived", async () => {
    await presence("present");
    await presence("not_arrived");

    expect(state.db.rows("event_competition_checkin_participants")[0]).toMatchObject({
      presence_status: "not_arrived",
      checked_in_at: null,
      checked_in_by: null,
    });
  });
});

describe("CI-B competition check-in session start", () => {
  it("puts two desks starting the same batch on one session", async () => {
    const start = () => redirectOf(startCompetitionCheckinAction(form({ eventId: "evt-c", cartId: "cart-1" })));

    const [first, second] = await Promise.all([start(), start()]);
    const sessions = state.db.rows("event_competition_checkin_sessions").filter((row) => row.registration_cart_id === "cart-1");

    expect(sessions).toHaveLength(1);
    expect(first).toBe(`/app/events/evt-c/competition/checkin/${sessions[0].id}`);
    expect(second).toBe(first);
  });
});

describe("CI-B competition check-in completion", () => {
  it("keeps the first completion stamp", async () => {
    const row = state.db.rows("event_competition_checkin_sessions")[0];
    Object.assign(row, { status: "complete", completed_at: "2026-10-23T10:00:00.000Z", completed_by: "staff-1" });
    state.db.rows("event_competition_checkin_participants")[0].presence_status = "present";
    state.db.rows("event_registrations").push({ id: "reg-other", event_id: "evt-c", order_id: null });
    state.db.rows("event_competition_entries").push({
      id: "entry-1",
      event_id: "evt-c",
      registration_id: "reg-other",
      division_id: "div-1",
      display_name: "Entry",
      status: "confirmed",
      eligibility_status: "eligible",
      verification_status: "verified",
    });

    state.userId = "staff-2";
    await completeCompetitionCheckinAction(form({ eventId: "evt-c", sessionId: "cs-1" }));

    expect(state.db.rows("event_competition_checkin_sessions")[0]).toMatchObject({
      completed_at: "2026-10-23T10:00:00.000Z",
      completed_by: "staff-1",
    });
  });
});
