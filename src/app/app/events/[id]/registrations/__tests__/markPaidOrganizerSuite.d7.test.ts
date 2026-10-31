import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7 owner decision (P2-3, reviewer finding): staff "mark registration paid" completes an in-person sale, so for an
 * organizer event it needs a current Organizer Suite entitlement once the sale is unpaid. It is refused before any
 * write. Already-paid registrations, ordinary studio events and order-backed registrations keep their existing behavior.
 */

const STUDIO = "studio-1";
const EVENT = "event-1";
const REGISTRATION = "reg-1";

const state = vi.hoisted(() => ({
  user: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
  admin: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => state.user.client.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false }),
}));

const { markEventRegistrationPaidAction } = await import("@/app/app/events/[id]/registrations/actions");

type Setup = { organizerId?: string | null; entitlements?: Row[]; paymentStatus?: string; orderId?: string | null };

function seed(setup: Setup = {}) {
  state.user = createTerminalFakeDb({
    events: [{ id: EVENT, event_type: "social", studio_id: STUDIO, organizer_id: setup.organizerId ?? null, studios: { stripe_connected_account_id: null } }],
    event_registrations: [
      {
        id: REGISTRATION,
        event_id: EVENT,
        studio_id: STUDIO,
        client_id: null,
        ticket_type_id: "t-1",
        quantity: 1,
        attendee_first_name: "Ada",
        attendee_last_name: "Lovelace",
        attendee_email: "ada@example.test",
        attendee_phone: null,
        status: "pending",
        payment_status: setup.paymentStatus ?? "pending",
        total_amount: 40,
        total_price: 40,
        currency: "USD",
        checked_in_at: null,
        stripe_payment_intent_id: null,
        order_id: setup.orderId ?? null,
      },
    ],
    event_payments: [],
  });
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function markPaid() {
  const formData = new FormData();
  formData.set("eventId", EVENT);
  formData.set("registrationId", REGISTRATION);
  try {
    await markEventRegistrationPaidAction(formData);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? `THROWN:${(error as Error).message}`;
  }
  return "NO_REDIRECT";
}

function registration() {
  return state.user.tables.event_registrations[0];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("markEventRegistrationPaidAction: unpaid organizer-event registrations need a current Organizer Suite entitlement", () => {
  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("refuses with $name before any write", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    expect(await markPaid()).toContain("error=organizer_suite_required");
    expect(registration()).toMatchObject({ status: "pending", payment_status: "pending" });
    expect(state.user.inserts).toHaveLength(0);
  });

  it("a failed registration (payment_status failed) is also refused", async () => {
    seed({ organizerId: "org-1", entitlements: [], paymentStatus: "failed" });
    expect(await markPaid()).toContain("error=organizer_suite_required");
    expect(registration()).toMatchObject({ payment_status: "failed" });
  });

  it("with a current grant it marks the registration paid, confirms it and records the payment", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    expect(await markPaid()).not.toContain("organizer_suite_required");
    expect(registration()).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect(state.user.inserts.filter((insert) => insert.table === "event_payments")).toHaveLength(1);
  });

  it("DanceAbel boundary: allowed at 03:59:59Z, refused at 04:00:00Z on 2027-07-09", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expect(await markPaid()).not.toContain("organizer_suite_required");
    expect(registration()).toMatchObject({ payment_status: "paid" });
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect(await markPaid()).toContain("error=organizer_suite_required");
  });

  it("an ordinary studio event (no organizer) is unaffected even with no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    expect(await markPaid()).not.toContain("organizer_suite_required");
    expect(registration()).toMatchObject({ status: "confirmed", payment_status: "paid" });
  });

  it("re-marking an already paid registration is not a new sale and is not gated", async () => {
    seed({ organizerId: "org-1", entitlements: [], paymentStatus: "paid" });
    expect(await markPaid()).not.toContain("organizer_suite_required");
  });

  it("an order-backed registration is still refused before any write (existing behavior unchanged)", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()], orderId: "order-1" });
    expect(await markPaid()).not.toContain("organizer_suite_required");
    expect(registration()).toMatchObject({ status: "pending", payment_status: "pending" });
  });
});
