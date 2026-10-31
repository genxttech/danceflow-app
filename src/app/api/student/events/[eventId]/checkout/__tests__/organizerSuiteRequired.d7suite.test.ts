import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

import { FakeTable, createFakeAdminClient, type Row } from "@/lib/supabase/__tests__/simpleFakeAdminClient";

/**
 * D7: student-app event checkout (src/app/api/student/events/[eventId]/checkout/route.ts) vs the Organizer Suite
 * entitlement.
 *
 * Rule: a NEW purchase on an event tied to an organizer needs a CURRENT Organizer Suite entitlement (or the Organizer
 * plan). The route refuses at a platform fee of 0 ("DanceFlow organizer checkout is not enabled for this listing.")
 * before any order is created; the Stripe step itself is the shared startEventOrderPayment (run for real here, so the
 * application fee it computes is asserted end to end). Events with no organizer are unaffected.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const REFUSAL = "DanceFlow organizer checkout is not enabled for this listing.";

let tables: Record<string, FakeTable>;
let sessionsCreate: Mock<(...args: unknown[]) => unknown>;
let paymentIntentsCreate: Mock<(...args: unknown[]) => unknown>;
let ipCounter = 0;
let requestCounter = 0;

const EMBEDDED_EVENT = { id: EVENT_ID, slug: "spring-showcase", name: "Spring Showcase" };
const EMBEDDED_STUDIO = {
  stripe_connected_account_id: "acct_1",
  stripe_connect_charges_enabled: true,
  stripe_connect_payouts_enabled: true,
  stripe_connect_onboarding_complete: true,
};

function fakeClient() {
  const base = createFakeAdminClient(tables);
  return {
    ...base,
    from(name: string) {
      const builder = base.from(name);
      return {
        ...builder,
        // The fake ignores embedded joins: an order row carries the event/studio relations startEventOrderPayment reads.
        insert: (payload: Row | Row[]) =>
          name === "event_orders" && !Array.isArray(payload)
            ? builder.insert({ ...payload, events: EMBEDDED_EVENT, studios: EMBEDDED_STUDIO })
            : builder.insert(payload),
        // The capacity reads use .gt / .or, which the shared fake does not model; they are no-ops here (no rows).
        select: () => {
          const query = builder.select() as unknown as Record<string, unknown>;
          query.gt = () => query;
          query.or = () => query;
          return query;
        },
      };
    },
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => fakeClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient() }));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    checkout: {
      sessions: { create: (...args: unknown[]) => sessionsCreate(...args), retrieve: vi.fn(), expire: vi.fn() },
    },
    paymentIntents: { create: (...args: unknown[]) => paymentIntentsCreate(...args), retrieve: vi.fn(), cancel: vi.fn() },
  }),
}));
vi.mock("@/lib/documents/event-signing", () => ({ beginEventSigningCheckpoint: vi.fn() }));
vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: vi.fn() }));
vi.mock("@/lib/auth/studentApiAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/studentApiAuth")>()),
  getStudentApiUser: async () => ({ id: "user-1", email: "student@example.com" }),
}));

const { POST } = await import("@/app/api/student/events/[eventId]/checkout/route");

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
  entitlements?: Row[];
  timezone?: string;
  existingOrders?: Row[];
  existingRegistrations?: Row[];
};

function seed(setup: Setup = {}) {
  tables = {
    events: table([
      {
        id: EVENT_ID,
        slug: "spring-showcase",
        name: "Spring Showcase",
        studio_id: STUDIO_ID,
        organizer_id: setup.organizerId ?? null,
        status: "published",
        visibility: "public",
        public_directory_enabled: true,
        registration_required: true,
        registration_opens_at: null,
        registration_closes_at: null,
        studios: {
          subscription_status: "active",
          stripe_connected_account_id: "acct_1",
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
        price: 100,
        currency: "USD",
        capacity: null,
        active: true,
        sale_starts_at: null,
        sale_ends_at: null,
        early_bird_enabled: false,
        early_bird_price: null,
        early_bird_ends_at: null,
        attendees_per_ticket: 1,
      },
    ]),
    event_orders: table((setup.existingOrders ?? []).map((row) => ({ ...row }))),
    event_registrations: table((setup.existingRegistrations ?? []).map((row) => ({ ...row }))),
    event_registration_items: table(),
    event_registration_attendees: table(),
    event_order_items: table(),
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

type Mode = "checkout" | "payment_sheet";

function freshRequestId() {
  requestCounter += 1;
  return `aaaaaaaa-bbbb-4ccc-8ddd-${String(requestCounter).padStart(12, "0")}`;
}

function request(mode: Mode, clientRequestId = freshRequestId()) {
  ipCounter += 1;
  return new NextRequest(`https://app.example.com/api/student/events/${EVENT_ID}/checkout`, {
    method: "POST",
    body: JSON.stringify({
      ticketSelections: [{ ticketTypeId: TICKET_ID, quantity: 1 }],
      buyerFirstName: "Sam",
      buyerLastName: "Student",
      clientRequestId,
      paymentMode: mode,
    }),
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.0.${ipCounter}` },
  });
}

function post(mode: Mode, clientRequestId?: string) {
  return POST(request(mode, clientRequestId), { params: Promise.resolve({ eventId: EVENT_ID }) });
}

async function expectRefused(response: Response, existingOrderCount = 0) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: REFUSAL });
  expect(sessionsCreate).not.toHaveBeenCalled();
  expect(paymentIntentsCreate).not.toHaveBeenCalled();
  expect(tables.event_orders.rows).toHaveLength(existingOrderCount);
  expect(tables.event_order_items.rows).toHaveLength(0);
  expect(tables.event_order_payment_attempts.rows).toHaveLength(0);
}

async function expectAllowed(response: Response, mode: Mode, feeCents: number | null) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(tables.event_orders.rows).toHaveLength(1);
  if (mode === "checkout") {
    expect(body.checkoutUrl).toBe("https://checkout.stripe.test/session");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = sessionsCreate.mock.calls[0] as [{ payment_intent_data: { application_fee_amount?: number } }];
    expect(params.payment_intent_data.application_fee_amount ?? null).toBe(feeCents);
  } else {
    expect(body.clientSecret).toBe("pi_secret");
    expect(paymentIntentsCreate).toHaveBeenCalledTimes(1);
    const [params] = paymentIntentsCreate.mock.calls[0] as [{ application_fee_amount?: number }];
    expect(params.application_fee_amount ?? null).toBe(feeCents);
  }
}

beforeEach(() => {
  sessionsCreate = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session", status: "open" });
  paymentIntentsCreate = vi.fn().mockResolvedValue({ id: "pi_1", client_secret: "pi_secret", status: "requires_payment_method" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MODES: Mode[] = ["checkout", "payment_sheet"];

describe.each(MODES)("student event checkout (%s): organizer events need a current Organizer Suite entitlement", (mode) => {
  it.each([
    { name: "no entitlement at all", entitlements: [] as Row[] },
    { name: "a lapsed manual grant", entitlements: [grant({ period_end: "2026-12-01" })] },
    { name: "a revoked grant", entitlements: [grant({ status: "revoked" })] },
  ])("refuses $name before creating an order or calling Stripe", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    await expectRefused(await post(mode));
  });

  it.each([
    { name: "Pro + current grant", planCode: "pro", entitlements: [grant()], fee: 300 },
    { name: "Growth + current grant", planCode: "growth", entitlements: [grant()], fee: 325 },
    { name: "Starter + current grant", planCode: "starter", entitlements: [grant({ period_end: "2027-07-09" })], fee: 325 },
    { name: "Organizer plan, no add-on", planCode: "organizer", entitlements: [] as Row[], fee: 350 },
    { name: "Pro + lapsed grant + active Stripe add-on", planCode: "pro", entitlements: [grant({ period_end: "2026-12-01" }), stripeItem()], fee: 300 },
  ])("allows $name and reaches Stripe with the expected application fee", async ({ planCode, entitlements, fee }) => {
    seed({ organizerId: "org-1", planCode, entitlements });
    await expectAllowed(await post(mode), mode, fee);
  });

  it("an event with no organizer is unaffected: no entitlement needed and no DanceFlow fee", async () => {
    seed({ organizerId: null, entitlements: [] });
    await expectAllowed(await post(mode), mode, null);
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
    const response = await post("checkout");
    if (allowed) await expectAllowed(response, "checkout", 300);
    else await expectRefused(response);
  });
});

describe("existing orders (same clientRequestId replay)", () => {
  const REPLAY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-999999999999";
  const paidOrder = {
    id: "order-paid",
    event_id: EVENT_ID,
    studio_id: STUDIO_ID,
    organizer_id: "org-1",
    client_request_id: REPLAY_ID,
    buyer_email: "student@example.com",
    status: "confirmed",
    payment_status: "paid",
    metadata: { requested_total_cents: 10000, user_id: "user-1" },
  };

  it("a paid order replayed while the Suite is current returns completed without Stripe", async () => {
    seed({
      organizerId: "org-1",
      entitlements: [grant()],
      existingOrders: [paidOrder],
      existingRegistrations: [{ id: "reg-1", order_id: "order-paid" }],
    });
    const response = await post("checkout", REPLAY_ID);
    expect(await response.json()).toEqual({ completed: true, orderId: "order-paid", registrationIds: ["reg-1"] });
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  // P2-2 (owner decision): a replay of an already PAID order returns its completed result even after the grant lapsed.
  it("a paid order replayed after the grant lapsed still returns completed, without Stripe or any write", async () => {
    seed({
      organizerId: "org-1",
      entitlements: [grant({ period_end: "2026-12-01" })],
      existingOrders: [paidOrder],
      existingRegistrations: [{ id: "reg-1", order_id: "order-paid" }],
    });
    const before = JSON.parse(JSON.stringify(tables));
    const first = await post("checkout", REPLAY_ID);
    const second = await post("payment_sheet", REPLAY_ID);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ completed: true, orderId: "order-paid", registrationIds: ["reg-1"] });
    expect(await second.json()).toEqual({ completed: true, orderId: "order-paid", registrationIds: ["reg-1"] });
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(paymentIntentsCreate).not.toHaveBeenCalled();
    expect(JSON.parse(JSON.stringify(tables))).toEqual(before);
  });

  it("a confirmed order replayed after the lapse is also returned as completed", async () => {
    seed({
      organizerId: "org-1",
      entitlements: [],
      existingOrders: [{ ...paidOrder, payment_status: "pending" }],
      existingRegistrations: [{ id: "reg-1", order_id: "order-paid" }],
    });
    expect(await (await post("checkout", REPLAY_ID)).json()).toMatchObject({ completed: true, orderId: "order-paid" });
  });

  it("another student's paid order is never revealed by reusing its clientRequestId", async () => {
    seed({
      organizerId: "org-1",
      entitlements: [],
      existingOrders: [{ ...paidOrder, metadata: { requested_total_cents: 10000, user_id: "someone-else" } }],
      existingRegistrations: [{ id: "reg-1", order_id: "order-paid" }],
    });
    await expectRefused(await post("checkout", REPLAY_ID), 1);
  });

  it("a paid order for a DIFFERENT event is not returned for this event's checkout", async () => {
    seed({
      organizerId: "org-1",
      entitlements: [],
      existingOrders: [{ ...paidOrder, event_id: "other-event" }],
      existingRegistrations: [{ id: "reg-1", order_id: "order-paid" }],
    });
    await expectRefused(await post("checkout", REPLAY_ID), 1);
  });

  it("an UNPAID pending order replayed after the lapse is refused (no grace window) and left untouched", async () => {
    const pending = { ...paidOrder, id: "order-pending", status: "pending", payment_status: "pending" };
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })], existingOrders: [pending] });
    await expectRefused(await post("checkout", REPLAY_ID), 1);
    expect(tables.event_orders.rows[0]).toEqual(pending);
  });

  it("an unpaid pending order replayed while the grant is current continues to payment", async () => {
    const pending = { ...paidOrder, id: "order-pending", status: "pending", payment_status: "pending", expires_at: new Date(Date.now() + 600_000).toISOString() };
    seed({ organizerId: "org-1", entitlements: [grant()], existingOrders: [{ ...pending, events: EMBEDDED_EVENT, studios: EMBEDDED_STUDIO, total_amount: 100, currency: "usd" }] });
    const response = await post("checkout", REPLAY_ID);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.checkoutUrl).toBe("https://checkout.stripe.test/session");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
  });
});
