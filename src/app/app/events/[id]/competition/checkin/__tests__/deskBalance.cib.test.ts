import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "../../../check-in/__tests__/fakeSupabase";

/** CI-B desk balance: the session balance is total - captured; an R2 refund never shows up as balance due. */

const state: { db: FakeDb } = { db: new FakeDb() };

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.db.client({ id: "staff-1" }) }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: "studio-1", studioRole: "studio_admin", isPlatformAdmin: false, userId: "staff-1" }),
}));

import { startCompetitionCheckinAction } from "../actions";

function seed(payments: Array<Record<string, unknown>>, total = 300) {
  return new FakeDb({
    events: [{ id: "evt-c", studio_id: "studio-1", organizer_id: null }],
    event_competition_registration_carts: [{ id: "cart-1", event_id: "evt-c", order_id: "order-1" }],
    event_registrations: [{ id: "reg-c", event_id: "evt-c", order_id: "order-1" }],
    event_orders: [{ id: "order-1", total_amount: total, currency: "USD", payment_status: "paid" }],
    event_payments: payments.map((p, i) => ({ id: `pay-${i}`, registration_id: "reg-c", ...p })),
  });
}

async function startAndRead(payments: Array<Record<string, unknown>>, total = 300) {
  state.db = seed(payments, total);
  const formData = new FormData();
  formData.set("eventId", "evt-c");
  formData.set("cartId", "cart-1");
  await startCompetitionCheckinAction(formData).catch((error) => {
    if (!String((error as { digest?: string }).digest ?? "").startsWith("NEXT_REDIRECT;")) throw error;
  });
  return state.db.rows("event_competition_checkin_sessions")[0];
}

beforeEach(() => {
  state.db = new FakeDb();
});

describe("CI-B competition check-in desk balance with refunds", () => {
  it("partial refund of 1 of 3 entries: balance 0, payment complete", async () => {
    const session = await startAndRead([{ amount: 300, refund_amount: 100, status: "paid" }]);
    expect(session).toMatchObject({ balance_due: 0, payment_status: "complete" });
  });
  it("full refund: balance 0, payment complete", async () => {
    const session = await startAndRead([{ amount: 300, refund_amount: 300, status: "refunded" }]);
    expect(session).toMatchObject({ balance_due: 0, payment_status: "complete" });
  });
  it("genuine desk balance stays due and a refund does not add to it", async () => {
    const session = await startAndRead([{ amount: 200, refund_amount: 50, status: "paid" }]);
    expect(session).toMatchObject({ balance_due: 100, payment_status: "balance_due" });
  });
  it("a pending or failed payment row does not count as captured", async () => {
    const session = await startAndRead([{ amount: 300, refund_amount: 0, status: "pending" }]);
    expect(session).toMatchObject({ balance_due: 300, payment_status: "balance_due" });
  });
});
