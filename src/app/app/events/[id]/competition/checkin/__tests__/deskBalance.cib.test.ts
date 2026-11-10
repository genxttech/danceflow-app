import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * CI-B: the desk session balance is order total - captured gross payments. An R2 refund (event_payments.refund_amount,
 * status 'refunded' once fully refunded) never becomes balance due, so the desk cannot collect refunded money again.
 */

const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb> }));

vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.client }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", studioRole: "studio_admin", isPlatformAdmin: false, userId: "staff-1" }),
}));

const { updateCompetitionCheckinPresenceAction } = await import("@/app/app/events/[id]/competition/checkin/actions");

function seed(payments: Row[], total = 300) {
  state.db = createTerminalFakeDb({
    events: [{ id: "evt-c", studio_id: "studio-1", organizer_id: null }],
    event_competition_checkin_sessions: [{ id: "sess-1", event_id: "evt-c", registration_cart_id: null, registration_id: "reg-c", order_id: "order-1", status: "in_progress" }],
    event_competition_checkin_participants: [{ id: "part-1", checkin_session_id: "sess-1", presence_status: "not_arrived", waiver_status: "waived" }],
    event_orders: [{ id: "order-1", total_amount: total, currency: "USD", payment_status: "partially_refunded" }],
    event_payments: payments.map((p, i) => ({ id: `pay-${i}`, registration_id: "reg-c", ...p })),
  });
}

async function balance() {
  const formData = new FormData();
  formData.set("eventId", "evt-c");
  formData.set("sessionId", "sess-1");
  formData.set("participantId", "part-1");
  formData.set("presenceStatus", "present");
  await updateCompetitionCheckinPresenceAction(formData);
  return state.db.tables.event_competition_checkin_sessions[0];
}

beforeEach(() => {
  state.db = createTerminalFakeDb({});
});

describe("CI-B competition desk balance with refunds", () => {
  it("partial refund of 1 of 3 entries: balance 0, payment complete (refund not collectible again)", async () => {
    seed([{ amount: 300, refund_amount: 100, status: "paid" }]);
    expect(await balance()).toMatchObject({ balance_due: 0, payment_status: "complete" });
  });
  it("full refund: balance 0 (a refunded payment is still captured money)", async () => {
    seed([{ amount: 300, refund_amount: 300, status: "refunded" }]);
    expect(await balance()).toMatchObject({ balance_due: 0, payment_status: "complete" });
  });
  it("genuine unpaid remainder stays due and a refund does not add to it", async () => {
    seed([{ amount: 200, refund_amount: 50, status: "paid" }]);
    expect(await balance()).toMatchObject({ balance_due: 100, payment_status: "balance_due" });
  });
  it("a pending or failed payment row is not captured", async () => {
    seed([{ amount: 300, refund_amount: 0, status: "pending" }]);
    expect(await balance()).toMatchObject({ balance_due: 300, payment_status: "balance_due" });
  });
});
