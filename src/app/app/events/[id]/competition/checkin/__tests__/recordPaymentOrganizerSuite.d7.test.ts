import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7: competition registration-desk payments. record_competition_checkin_payment records payment against an EXISTING
 * competition order and also confirms an order that is still pending once its balance reaches zero. For an organizer
 * event, completing an UNPAID PENDING order after the Organizer Suite entitlement lapsed is refused before the RPC
 * (no grace window). Confirmed/paid orders are existing authorized obligations and stay recordable; ordinary studio
 * events are unaffected; nothing already recorded is touched; a refusal writes nothing.
 */

const STUDIO = "studio-1";
const EVENT = "event-1";
const SESSION = "session-1";
const ORDER = "order-1";
const REFUSAL = "This organizer is not accepting new registrations or payments for this event right now, and this registration is still unpaid. Nothing was recorded.";

const state = vi.hoisted(() => ({
  user: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
  admin: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
}));

vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => state.user.client.from(table),
    rpc: (name: string, args: Record<string, unknown>) => state.user.client.rpc(name, args),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "front_desk", userId: "user-1", isPlatformAdmin: false }),
}));

const { recordCompetitionCheckinPaymentAction } = await import("@/app/app/events/[id]/competition/checkin/actions");

type Setup = {
  organizerId?: string | null;
  entitlements?: Row[];
  order?: Row | null;
  noSession?: boolean;
};

function seed(setup: Setup = {}) {
  state.user = createTerminalFakeDb(
    {
      events: [{ id: EVENT, studio_id: STUDIO, organizer_id: setup.organizerId ?? null }],
      event_competition_checkin_sessions: setup.noSession
        ? []
        : [{ id: SESSION, event_id: EVENT, order_id: ORDER, registration_id: "reg-1", registration_cart_id: null, status: "in_progress" }],
      event_orders:
        setup.order === null ? [] : [{ id: ORDER, event_id: EVENT, status: "pending", payment_status: "pending", ...(setup.order ?? {}) }],
    },
    { record_competition_checkin_payment: () => ({ outcome: "recorded" }) },
  );
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function record() {
  const formData = new FormData();
  formData.set("eventId", EVENT);
  formData.set("sessionId", SESSION);
  formData.set("paymentMethod", "cash");
  formData.set("amount", "40");
  try {
    await recordCompetitionCheckinPaymentAction(formData);
    return { error: null as string | null };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function rpcRecorded() {
  return state.user.rpcCalls.filter((call) => call.name === "record_competition_checkin_payment");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("competition desk payment: completing an unpaid pending order needs a current Organizer Suite entitlement", () => {
  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("refuses an unpaid pending order with $name before the RPC", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    expect((await record()).error).toBe(REFUSAL);
    expect(rpcRecorded()).toHaveLength(0);
    expect(state.user.inserts).toHaveLength(0);
  });

  it("with a current grant the payment is recorded through the RPC as before", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
    expect(rpcRecorded()[0].args).toMatchObject({ p_event_id: EVENT, p_session_id: SESSION, p_amount: 40, p_payment_method: "cash" });
  });

  it("DanceAbel boundary: allowed at 03:59:59Z, refused at 04:00:00Z on 2027-07-09", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    await record();
    expect(rpcRecorded()).toHaveLength(1);
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect((await record()).error).toBe(REFUSAL);
    expect(rpcRecorded()).toHaveLength(0);
  });

  it("an order that is already confirmed is an existing obligation: recording is unchanged after the lapse", async () => {
    seed({ organizerId: "org-1", entitlements: [], order: { status: "confirmed", payment_status: "pending" } });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
  });

  it("an order already marked paid is not blocked", async () => {
    seed({ organizerId: "org-1", entitlements: [], order: { status: "pending", payment_status: "paid" } });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
  });

  it("an ordinary studio event (no organizer) is unaffected even with no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
  });

  it("a missing session or order is left to the RPC to refuse (the gate does not invent a result)", async () => {
    seed({ organizerId: "org-1", entitlements: [], noSession: true });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
    seed({ organizerId: "org-1", entitlements: [], order: null });
    await record();
    expect(rpcRecorded()).toHaveLength(1);
  });

  it("fails closed when the order cannot be read: nothing is recorded", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    const original = state.user.client.from;
    state.user.client.from = ((table: string) => {
      if (table === "event_orders") throw new Error("read failed");
      return original(table);
    }) as typeof original;
    expect((await record()).error).toBe("read failed");
    expect(rpcRecorded()).toHaveLength(0);
  });
});
