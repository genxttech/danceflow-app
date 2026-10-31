import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

vi.mock("server-only", () => ({}));

/**
 * D7 owner decision P2-3: collecting a NEW Terminal ticket sale for an organizer event needs a current Organizer Suite
 * entitlement. The check sits before the ticket hold and before any PaymentIntent exists. Fee behavior is unchanged
 * (the reader PaymentIntent never carries a DanceFlow application fee). Ordinary studio events, other payment types and
 * payments that are no longer pending are untouched.
 */

const STUDIO = "studio-1";
const PAYMENT = "payment-1";
const REGISTRATION = "reg-1";

const state = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
  paymentIntentsCreate: vi.fn(),
  readerProcess: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "front_desk", isPlatformAdmin: false }),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    accounts: { retrieve: async () => ({ charges_enabled: true, capabilities: { card_payments: "active" } }) },
    paymentIntents: { create: state.paymentIntentsCreate, cancel: vi.fn() },
    terminal: { readers: { processPaymentIntent: state.readerProcess } },
  }),
}));
vi.mock("@/lib/payments/customer", () => ({ ensureConnectedStripeCustomer: vi.fn() }));
vi.mock("@/lib/payments/terminal-quick-charge", () => ({ countTerminalPaymentSessions: async () => 0 }));

type Setup = {
  organizerId?: string | null;
  entitlements?: Row[];
  paymentType?: string;
  paymentStatus?: string;
  holdOk?: boolean;
  registration?: boolean;
};

function seed(setup: Setup = {}) {
  state.db = createTerminalFakeDb(
    {
      studios: [{ id: STUDIO, name: "Studio", stripe_connected_account_id: "acct_1", timezone: "America/New_York" }],
      payments: [
        {
          id: PAYMENT,
          studio_id: STUDIO,
          client_id: null,
          client_membership_id: null,
          amount: 50,
          currency: "usd",
          status: setup.paymentStatus ?? "pending",
          payment_type: setup.paymentType ?? "event_registration",
          fulfillment_type: null,
          source: "stripe",
          client_package_id: null,
          external_reference: REGISTRATION,
          notes: null,
        },
      ],
      stripe_terminal_readers: [
        { id: "reader-1", studio_id: STUDIO, active: true, status: "online", stripe_reader_id: "tmr_1", terminal_location_id: "loc", stripe_location_id: "tml_1", label: "Front" },
      ],
      terminal_payment_sessions: [],
      event_registrations:
        setup.registration === false
          ? []
          : [{ id: REGISTRATION, studio_id: STUDIO, event_id: "event-1", events: { studio_id: STUDIO, organizer_id: setup.organizerId ?? null } }],
      studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
      usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    },
    {
      hold_terminal_event_registration: () => (setup.holdOk === false ? { ok: false, reason: "capacity_unavailable" } : { ok: false, reason: "capacity_unavailable" }),
    },
  );
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function start() {
  vi.resetModules();
  const { POST } = await import("@/app/api/stripe/terminal/payments/start/route");
  const body = new FormData();
  body.set("paymentId", PAYMENT);
  body.set("readerId", "reader-1");
  const response = await POST(new NextRequest("https://app.test/api/stripe/terminal/payments/start", { method: "POST", body }));
  return new URL(response.headers.get("location") ?? "https://none.test");
}

function error(url: URL) {
  return url.searchParams.get("error");
}

function holdCalls() {
  return state.db.rpcCalls.filter((call) => call.name === "hold_terminal_event_registration");
}

beforeEach(() => {
  state.paymentIntentsCreate.mockReset();
  state.readerProcess.mockReset();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Terminal start: new ticket sales for organizer events need a current Organizer Suite entitlement", () => {
  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("refuses $name before the ticket hold and before any PaymentIntent", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    expect(error(await start())).toBe("terminal_organizer_suite_required");
    expect(holdCalls()).toHaveLength(0);
    expect(state.paymentIntentsCreate).not.toHaveBeenCalled();
    expect(state.db.inserts).toHaveLength(0);
  });

  it("with a current grant the gate passes and the existing ticket-hold step runs", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    expect(error(await start())).toBe("terminal_tickets_unavailable");
    expect(holdCalls()).toHaveLength(1);
  });

  it("DanceAbel boundary: allowed before 2027-07-09T04:00:00Z, refused at it", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expect(error(await start())).toBe("terminal_tickets_unavailable");
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect(error(await start())).toBe("terminal_organizer_suite_required");
  });

  it("an ordinary studio event (no organizer) is unaffected even with no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    expect(error(await start())).toBe("terminal_tickets_unavailable");
    expect(holdCalls()).toHaveLength(1);
  });

  it("other payment types are never gated: no registration lookup is needed", async () => {
    seed({ organizerId: "org-1", entitlements: [], paymentType: "general", registration: false });
    const url = await start();
    expect(error(url)).not.toBe("terminal_organizer_suite_required");
    expect(error(url)).not.toBe("terminal_ticket_sale_not_payable");
    expect(holdCalls()).toHaveLength(0);
  });

  it("a payment that is already paid is refused by the existing rule and nothing else changes", async () => {
    seed({ organizerId: "org-1", entitlements: [], paymentStatus: "paid" });
    expect(error(await start())).toBe("terminal_payment_not_pending");
    expect(state.db.tables.payments[0].status).toBe("paid");
    expect(state.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("a sale whose registration cannot be found is not payable (same result the ticket hold would give)", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()], registration: false });
    expect(error(await start())).toBe("terminal_ticket_sale_not_payable");
    expect(state.paymentIntentsCreate).not.toHaveBeenCalled();
  });
});

describe("Terminal fee behavior is preserved", () => {
  it("the reader PaymentIntent source carries no DanceFlow application fee", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/app/api/stripe/terminal/payments/start/route.ts", "utf8");
    expect(source).not.toContain("application_fee");
    expect(source).not.toContain("getOrganizerPlatformFeePercent");
  });
});
