import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";
import { TERMINAL_ORGANIZER_SUITE_MESSAGE } from "@/lib/events/terminalOrganizerSuite";

/**
 * D7 owner decision P2-3 at sale creation: a NEW card-reader (Terminal) ticket sale for an organizer event is refused,
 * with nothing created, once the Organizer Suite entitlement has lapsed. Manual sales (cash, check, external card, comp)
 * are NOT changed by this decision, ordinary studio events are never gated, and no fee is introduced.
 */

const STUDIO = "studio-1";

const state = vi.hoisted(() => ({
  user: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
  admin: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
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
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "front_desk", isPlatformAdmin: false }),
}));

const { sellTicketsAction } = await import("@/app/app/events/sell-tickets/actions");

function seed(setup: { organizerId?: string | null; entitlements?: Row[] } = {}) {
  const shared = {
    events: [{ id: "event-1", studio_id: STUDIO, organizer_id: setup.organizerId ?? null, name: "Gala", status: "published" }],
    event_ticket_types: [{ id: "ticket-1", event_id: "event-1", name: "GA", price: 50, currency: "USD", capacity: null, active: true, attendees_per_ticket: 1 }],
    clients: [],
    event_registrations: [],
    event_registration_items: [],
    event_registration_attendees: [],
    event_payments: [],
    payments: [],
    attendance_records: [],
  };
  state.user = createTerminalFakeDb(shared);
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function sell(paymentMethod: string) {
  const formData = new FormData();
  formData.set("eventId", "event-1");
  formData.set("ticketTypeId", "ticket-1");
  formData.set("quantity", "2");
  formData.set("paymentMethod", paymentMethod);
  formData.set("attendeeFirstName", "Ada");
  formData.set("attendeeLastName", "Lovelace");
  formData.set("attendeeEmail", "ada@example.test");
  try {
    return { result: await sellTicketsAction({}, formData), redirectTo: null as string | null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("REDIRECT:")) return { result: null, redirectTo: message.slice("REDIRECT:".length) };
    throw error;
  }
}

function created(table: string) {
  return state.user.inserts.filter((insert) => insert.table === table);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("sellTicketsAction: new card-reader sales for organizer events need a current Organizer Suite entitlement", () => {
  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("refuses a card-reader sale with $name and creates nothing", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    const { result, redirectTo } = await sell("card_reader");
    expect(redirectTo).toBeNull();
    expect(result).toEqual({ error: TERMINAL_ORGANIZER_SUITE_MESSAGE });
    expect(created("event_registrations")).toHaveLength(0);
    expect(created("payments")).toHaveLength(0);
  });

  it("with a current grant the card-reader sale is created and sent to the reader (fee behavior unchanged: no fee fields)", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    const { redirectTo } = await sell("card_reader");
    expect(redirectTo).toMatch(/^\/app\/payments\/terminal\//);
    expect(created("event_registrations")).toHaveLength(1);
    const [payment] = created("payments");
    expect(payment.values).toMatchObject({ amount: 100, payment_channel: "terminal", payment_type: "event_registration" });
    expect(Object.keys(payment.values).some((key) => key.includes("fee"))).toBe(false);
  });

  it("an ordinary studio event (no organizer) is unaffected even with no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    const { redirectTo } = await sell("card_reader");
    expect(redirectTo).toMatch(/^\/app\/payments\/terminal\//);
    expect(created("event_registrations")).toHaveLength(1);
  });

  it.each(["cash", "check", "external_card", "comp"])("manual %s sales are unchanged by this decision (open question reported)", async (method) => {
    seed({ organizerId: "org-1", entitlements: [] });
    const { result, redirectTo } = await sell(method);
    expect(result).toBeNull();
    expect(redirectTo).toMatch(/manual_ticket_sale_created/);
    expect(created("event_registrations")).toHaveLength(1);
  });
});
