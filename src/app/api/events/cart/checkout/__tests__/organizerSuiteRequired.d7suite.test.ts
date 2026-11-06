import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

import { FakeTable, createFakeAdminClient, type Row } from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * D7: public event cart checkout (src/app/api/events/cart/checkout/route.ts) vs the Organizer Suite entitlement.
 *
 * Rule: a NEW purchase on an event tied to an organizer needs a CURRENT Organizer Suite entitlement (or the Organizer
 * plan); the route treats a platform fee of 0 as "Suite required" and redirects with ?error=organizer_suite_required
 * before any order, registration, slot hold or Stripe call. Events with no organizer are unaffected.
 * Current = status active and now < local 00:00 of period_end in studios.timezone (exclusive).
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const SLOT_ID = "22222222-2222-4222-8222-222222222222";

let tables: Record<string, FakeTable>;
let stripeCreate: Mock<(...args: unknown[]) => unknown>;
let ipCounter = 0;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => createFakeAdminClient(tables),
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: { sessions: { create: (...args: unknown[]) => stripeCreate(...args), expire: vi.fn() } },
  }),
}));
vi.mock("@/lib/documents/event-signing", () => ({
  beginEventSigningCheckpoint: vi.fn(),
}));

const { POST } = await import("@/app/api/events/cart/checkout/route");

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

type Setup = {
  organizerId?: string | null;
  planCode?: string;
  subscriptionStatus?: string;
  entitlements?: Row[];
  timezone?: string;
  existingOrders?: Row[];
};

function seed(setup: Setup = {}) {
  tables = {
    events: table([
      {
        id: EVENT_ID,
        slug: "test-event",
        name: "Test Event",
        studio_id: STUDIO_ID,
        organizer_id: setup.organizerId ?? null,
        status: "published",
        visibility: "public",
        public_directory_enabled: true,
        registration_required: true,
        registration_opens_at: null,
        registration_closes_at: null,
        studios: {
          id: STUDIO_ID,
          name: "Test Studio",
          subscription_status: "active",
          stripe_connected_account_id: "acct_123",
          stripe_connect_charges_enabled: true,
          stripe_connect_payouts_enabled: true,
          stripe_connect_onboarding_complete: true,
        },
      },
    ]),
    event_document_requirements: table(),
    event_ticket_types: table([
      {
        id: TICKET_ID,
        event_id: EVENT_ID,
        name: "General Admission",
        description: null,
        ticket_kind: null,
        price: 100,
        currency: "USD",
        capacity: null,
        active: true,
        sale_starts_at: null,
        sale_ends_at: null,
        attendees_per_ticket: 1,
      },
    ]),
    event_private_lesson_slots: table([
      {
        id: SLOT_ID,
        event_id: EVENT_ID,
        coach_id: "coach-1",
        block_id: null,
        studio_id: STUDIO_ID,
        organizer_id: setup.organizerId ?? null,
        starts_at: "2027-03-01T15:00:00Z",
        ends_at: "2027-03-01T16:00:00Z",
        price: 100,
        location_label: "Studio A",
        status: "available",
        payment_status: "unpaid",
        event_guest_coaches: { id: "coach-1", name: "Guest Coach" },
      },
    ]),
    event_registrations: table(),
    event_registration_items: table(),
    event_registration_attendees: table(),
    event_order_items: table(),
    event_orders: table((setup.existingOrders ?? []).map((row) => ({ ...row }))),
    studio_subscriptions: table([
      {
        id: "sub-1",
        studio_id: STUDIO_ID,
        status: setup.subscriptionStatus ?? "active",
        subscription_plans: { code: setup.planCode ?? "pro", name: "Plan" },
      },
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
  return {
    id: "item-1",
    source: "stripe_subscription_item",
    status: "active",
    period_start: null,
    period_end: null,
    stripe_subscription_item_id: "si_1",
    ...overrides,
  };
}

type Cart = "ticket" | "slot";

function request(cart: Cart) {
  ipCounter += 1;
  const form = new FormData();
  form.set("eventSlug", "test-event");
  form.set("attendeeFirstName", "Taylor");
  form.set("attendeeLastName", "Attendee");
  form.set("attendeeEmail", "attendee@example.com");
  if (cart === "ticket") {
    form.set("ticketTypeIds", TICKET_ID);
    form.set("ticketQuantities", "1");
  } else {
    form.set("slotIds", SLOT_ID);
  }
  return new NextRequest("https://app.example.com/api/events/cart/checkout", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": `10.77.0.${ipCounter}` },
  });
}

function slotRow() {
  return tables.event_private_lesson_slots.rows[0];
}

function expectRefused(response: Response, existingOrderCount = 0) {
  expect(response.headers.get("location")).toContain("error=organizer_suite_required");
  expect(stripeCreate).not.toHaveBeenCalled();
  expect(tables.event_orders.rows).toHaveLength(existingOrderCount);
  expect(tables.event_registrations.rows).toHaveLength(0);
  expect(tables.event_order_items.rows).toHaveLength(0);
  expect(slotRow().status).toBe("available");
  expect(slotRow().payment_status).toBe("unpaid");
  expect(slotRow().order_id).toBeUndefined();
}

function expectAllowed(response: Response, cart: Cart, feeCents: number | null) {
  expect(response.headers.get("location")).toBe("https://checkout.stripe.test/session");
  expect(stripeCreate).toHaveBeenCalledTimes(1);
  expect(tables.event_orders.rows).toHaveLength(1);
  if (cart === "slot") expect(slotRow().status).toBe("held");
  const [params] = stripeCreate.mock.calls[0] as [{ payment_intent_data: { application_fee_amount?: number } }];
  expect(params.payment_intent_data.application_fee_amount ?? null).toBe(feeCents);
}

beforeEach(() => {
  stripeCreate = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const CARTS: Cart[] = ["ticket", "slot"];

describe.each(CARTS)("cart checkout (%s cart): organizer events need a current Organizer Suite entitlement", (cart) => {
  it.each([
    { name: "no entitlement at all", entitlements: [] as Row[] },
    { name: "a lapsed manual grant", entitlements: [grant({ period_end: "2026-12-01" })] },
    { name: "a revoked (inactive) grant", entitlements: [grant({ status: "revoked" })] },
    { name: "a grant that has not started yet", entitlements: [grant({ period_start: "2027-02-01" })] },
  ])("refuses $name before any order, hold or Stripe call", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    expectRefused(await POST(request(cart)));
  });

  it.each([
    { name: "Pro + current open-ended grant", planCode: "pro", entitlements: [grant()], fee: 300 },
    { name: "Pro + grant ending in the future", planCode: "pro", entitlements: [grant({ period_end: "2027-07-09" })], fee: 300 },
    { name: "Growth + current grant", planCode: "growth", entitlements: [grant()], fee: 325 },
    { name: "Starter + current grant", planCode: "starter", entitlements: [grant()], fee: 325 },
    { name: "Organizer plan, no add-on", planCode: "organizer", entitlements: [] as Row[], fee: 350 },
    {
      name: "Pro + lapsed grant + active Stripe add-on",
      planCode: "pro",
      entitlements: [grant({ period_end: "2026-12-01" }), stripeItem()],
      fee: 300,
    },
  ])("allows $name and reaches Stripe with the expected application fee", async ({ planCode, entitlements, fee }) => {
    seed({ organizerId: "org-1", planCode, entitlements });
    expectAllowed(await POST(request(cart)), cart, fee);
  });

  it("refuses a current grant when the studio's own subscription is not active (fee 0)", async () => {
    seed({ organizerId: "org-1", subscriptionStatus: "canceled", entitlements: [grant()] });
    expectRefused(await POST(request(cart)));
  });

  it("an event with no organizer is unaffected: no entitlement needed and no DanceFlow fee", async () => {
    seed({ organizerId: null, entitlements: [] });
    expectAllowed(await POST(request(cart)), cart, null);
  });
});

describe("DanceAbel boundary: grant period_end 2027-07-09, America/New_York", () => {
  it.each([
    { at: "2027-07-08T20:00:00Z", allowed: true },
    { at: "2027-07-09T03:59:59Z", allowed: true },
    { at: "2027-07-09T04:00:00Z", allowed: false },
    { at: "2027-07-10T12:00:00Z", allowed: false },
  ])("at $at allowed=$allowed", async ({ at, allowed }) => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date(at));
    const response = await POST(request("ticket"));
    if (allowed) expectAllowed(response, "ticket", 300);
    else expectRefused(response);
  });

  it("the same date in UTC ends four hours earlier (studio timezone matters)", async () => {
    seed({ organizerId: "org-1", timezone: "UTC", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T00:00:00Z"));
    expectRefused(await POST(request("ticket")));
  });
});

describe("existing orders are not re-evaluated", () => {
  it("a refused new attempt leaves the buyer's earlier paid and in-flight orders untouched", async () => {
    const paid = {
      id: "order-paid",
      event_id: EVENT_ID,
      studio_id: STUDIO_ID,
      organizer_id: "org-1",
      buyer_email: "attendee@example.com",
      status: "confirmed",
      payment_status: "paid",
      metadata: { source: "event_cart_v1" },
    };
    const inFlight = {
      id: "order-in-flight",
      event_id: EVENT_ID,
      studio_id: STUDIO_ID,
      organizer_id: "org-1",
      buyer_email: "attendee@example.com",
      status: "pending",
      payment_status: "pending",
      stripe_checkout_session_id: "cs_old",
      metadata: { source: "event_cart_v1" },
    };
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })], existingOrders: [paid, inFlight] });
    expectRefused(await POST(request("ticket")), 2);
    expect(tables.event_orders.rows).toEqual([paid, inFlight]);
  });
});
