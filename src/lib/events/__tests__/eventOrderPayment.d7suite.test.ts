import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NextRequest } from "next/server";

import { FakeTable, createFakeAdminClient, type Row } from "@/lib/payments/__tests__/fakeSupabase";

/**
 * D7: startEventOrderPayment (src/lib/events/event-order-payment.ts), the shared payment step used by the student
 * checkout and by both resume-after-signing routes (web cart and student app), vs the Organizer Suite entitlement.
 *
 * For an order on an organizer event the platform fee is read at payment start; a fee of 0 means "Organizer Suite
 * required" and the helper throws before extending the hold, creating any Stripe object or recording an attempt.
 * An order that is already paid/confirmed returns `completed` before the check (never re-evaluated).
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const REFUSAL = "DanceFlow organizer checkout is not enabled for this listing.";

let tables: Record<string, FakeTable>;
let sessionsCreate: Mock<(...args: unknown[]) => unknown>;
let paymentIntentsCreate: Mock<(...args: unknown[]) => unknown>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient(tables),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: (...args: unknown[]) => sessionsCreate(...args),
        retrieve: vi.fn(),
        expire: vi.fn(),
      },
    },
    paymentIntents: { create: (...args: unknown[]) => paymentIntentsCreate(...args), retrieve: vi.fn() },
  }),
}));

const { startEventOrderPayment } = await import("@/lib/events/event-order-payment");

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

type Setup = {
  organizerId?: string | null;
  planCode?: string;
  entitlements?: Row[];
  timezone?: string;
  order?: Row;
};

function seed(setup: Setup = {}) {
  tables = {
    event_orders: table([
      {
        id: "order-1",
        event_id: EVENT_ID,
        studio_id: STUDIO_ID,
        organizer_id: setup.organizerId ?? null,
        buyer_email: "buyer@example.com",
        total_amount: 100,
        currency: "usd",
        status: "pending",
        payment_status: "pending",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        stripe_checkout_session_id: null,
        stripe_payment_intent_id: null,
        events: { id: EVENT_ID, slug: "spring-showcase", name: "Spring Showcase" },
        studios: {
          stripe_connected_account_id: "acct_1",
          stripe_connect_charges_enabled: true,
          stripe_connect_payouts_enabled: true,
          stripe_connect_onboarding_complete: true,
        },
        metadata: { requested_total_cents: 10000 },
        ...(setup.order ?? {}),
      },
    ]),
    event_order_items: table([{ id: "item-1", order_id: "order-1", quantity: 1, unit_price: 100, description: "GA" }]),
    event_registrations: table([{ id: "reg-1", order_id: "order-1" }]),
    event_order_payment_attempts: table(),
    studio_subscriptions: table([
      { id: "sub-1", studio_id: STUDIO_ID, status: "active", subscription_plans: { code: setup.planCode ?? "pro" } },
    ]),
    usage_addon_entitlements: table(
      (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO_ID, feature_key: "organizer_suite", ...row })),
    ),
    studios: table([{ id: STUDIO_ID, timezone: setup.timezone ?? "America/New_York" }]),
  };
}

function grant(overrides: Row = {}): Row {
  return { id: "grant-1", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides };
}

function stripeItem(overrides: Row = {}): Row {
  return { id: "item-1", source: "stripe_subscription_item", status: "active", period_start: null, period_end: null, ...overrides };
}

function fakeRequest(): NextRequest {
  return { nextUrl: { origin: "https://app.example.com" } } as unknown as NextRequest;
}

type Mode = "checkout" | "payment_sheet";

function start(mode: Mode) {
  return startEventOrderPayment({
    request: fakeRequest(),
    orderId: "order-1",
    surface: mode === "payment_sheet" ? "student_app" : "web",
    paymentMode: mode,
  });
}

function order() {
  return tables.event_orders.rows[0];
}

async function expectRefused(mode: Mode) {
  const before = { ...order() };
  await expect(start(mode)).rejects.toThrow(REFUSAL);
  expect(sessionsCreate).not.toHaveBeenCalled();
  expect(paymentIntentsCreate).not.toHaveBeenCalled();
  expect(tables.event_order_payment_attempts.rows).toHaveLength(0);
  // The hold is not extended and the order is not otherwise touched.
  expect(order()).toEqual(before);
}

async function expectAllowed(mode: Mode, feeCents: number | null) {
  const result = await start(mode);
  if (mode === "checkout") {
    expect(result.checkoutUrl).toBe("https://checkout.stripe.test/session");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0] as [{ payment_intent_data: { application_fee_amount?: number } }];
    expect(params.payment_intent_data.application_fee_amount ?? null).toBe(feeCents);
  } else {
    expect(result.clientSecret).toBe("pi_secret");
    expect(paymentIntentsCreate).toHaveBeenCalledTimes(1);
    const [params] = paymentIntentsCreate.mock.calls[0] as [{ application_fee_amount?: number }];
    expect(params.application_fee_amount ?? null).toBe(feeCents);
  }
  expect(tables.event_order_payment_attempts.rows).toHaveLength(1);
}

beforeEach(() => {
  sessionsCreate = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session", status: "open" });
  paymentIntentsCreate = vi.fn().mockResolvedValue({ id: "pi_1", client_secret: "pi_secret", status: "requires_payment_method" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const MODES: Mode[] = ["checkout", "payment_sheet"];

describe.each(MODES)("startEventOrderPayment (%s): organizer orders need a current Organizer Suite entitlement", (mode) => {
  it.each([
    { name: "no entitlement at all", entitlements: [] as Row[] },
    { name: "a lapsed manual grant", entitlements: [grant({ period_end: "2026-12-01" })] },
    { name: "an expired-status grant with a future period_end", entitlements: [grant({ status: "expired", period_end: "2027-07-09" })] },
  ])("refuses $name with no Stripe object, no attempt and no hold extension", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    await expectRefused(mode);
  });

  it.each([
    { name: "Pro + current grant", planCode: "pro", entitlements: [grant()], fee: 300 },
    { name: "Growth + current grant", planCode: "growth", entitlements: [grant()], fee: 325 },
    { name: "Starter + current grant", planCode: "starter", entitlements: [grant({ period_end: "2027-07-09" })], fee: 325 },
    { name: "Organizer plan, no add-on", planCode: "organizer", entitlements: [] as Row[], fee: 350 },
    { name: "Pro + lapsed grant + active Stripe add-on", planCode: "pro", entitlements: [grant({ period_end: "2026-12-01" }), stripeItem()], fee: 300 },
  ])("allows $name and creates the Stripe object with the expected application fee", async ({ planCode, entitlements, fee }) => {
    seed({ organizerId: "org-1", planCode, entitlements });
    await expectAllowed(mode, fee);
  });

  it("an order on an event with no organizer is unaffected: no entitlement needed and no DanceFlow fee", async () => {
    seed({ organizerId: null, entitlements: [] });
    await expectAllowed(mode, null);
  });

  it("an already-paid organizer order returns completed and is never re-evaluated", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })], order: { status: "confirmed", payment_status: "paid" } });
    const result = await start(mode);
    expect(result).toEqual({ completed: true, orderId: "order-1", registrationIds: ["reg-1"] });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
  });
});

describe("DanceAbel boundary: grant period_end 2027-07-09, America/New_York", () => {
  it.each([
    { at: "2027-07-08T20:00:00Z", allowed: true },
    { at: "2027-07-09T03:59:59Z", allowed: true },
    { at: "2027-07-09T04:00:00Z", allowed: false },
  ])("at $at allowed=$allowed", async ({ at, allowed }) => {
    vi.setSystemTime(new Date(at));
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    if (allowed) await expectAllowed("checkout", 300);
    else await expectRefused("checkout");
  });
});

describe("unpaid pending orders are evaluated at payment start (current behaviour, see D7 report)", () => {
  it("a pending order with a still-open Checkout Session attempt is refused once the grant has lapsed, without touching Stripe", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] });
    tables.event_order_payment_attempts.rows.push({
      id: "attempt-1",
      order_id: "order-1",
      kind: "checkout_session",
      surface: "web",
      stripe_account_id: "acct_1",
      stripe_checkout_session_id: "cs_open",
      stripe_payment_intent_id: null,
      status: "open",
      created_at: "2027-01-15T11:50:00Z",
    });
    await expect(start("checkout")).rejects.toThrow(REFUSAL);
    expect(sessionsCreate).not.toHaveBeenCalled();
    // The open attempt itself is left exactly as it was (not closed, not expired).
    expect(tables.event_order_payment_attempts.rows).toHaveLength(1);
    expect(tables.event_order_payment_attempts.rows[0].status).toBe("open");
  });
});
