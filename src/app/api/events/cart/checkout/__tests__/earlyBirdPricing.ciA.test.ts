import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";

import { FakeTable, createFakeAdminClient, type Row } from "@/lib/supabase/__tests__/simpleFakeAdminClient";
import { ORGANIZER_STANDARD_FEE_PERCENT } from "@/lib/events/platformFee";

/**
 * CI-A: the web cart checkout charges the server-authoritative effective ticket price (early bird strictly before its
 * cutoff), in integer cents, consistently across the order, registrations, item snapshots, Stripe line items and the
 * platform fee; it refuses (before writing anything) a price higher than the one the buyer was shown.
 * Drives the real POST handler against a fake admin client.
 */

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";
const EARLY_ID = "11111111-1111-4111-8111-111111111111";
const REGULAR_ID = "22222222-2222-4222-8222-222222222222";
const CUTOFF = "2027-03-01T06:00:00.000Z";
const CUTOFF_MS = Date.parse(CUTOFF);

let tables: Record<string, FakeTable>;
let stripeSessionsCreate: Mock<(...args: unknown[]) => unknown>;
let beginEventSigningCheckpointMock: Mock<(...args: unknown[]) => unknown>;
let ipCounter = 0;

function table(rows: Row[] = []) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function ticketRow(overrides: Row = {}): Row {
  return {
    id: EARLY_ID,
    event_id: EVENT_ID,
    name: "Early Bird Pass",
    description: null,
    ticket_kind: null,
    price: 40,
    currency: "USD",
    capacity: null,
    active: true,
    sale_starts_at: null,
    sale_ends_at: null,
    attendees_per_ticket: 1,
    early_bird_enabled: true,
    early_bird_price: 30,
    early_bird_ends_at: CUTOFF,
    ...overrides,
  };
}

function buildTables(options: { organizerHosted?: boolean; tickets?: Row[]; requiredDocument?: boolean } = {}) {
  const organizerId = options.organizerHosted ? "organizer-1" : null;
  return {
    events: table([
      {
        id: EVENT_ID,
        slug: "test-event",
        name: "Test Event",
        studio_id: STUDIO_ID,
        organizer_id: organizerId,
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
    studio_subscriptions: table(
      options.organizerHosted ? [{ studio_id: STUDIO_ID, status: "active", subscription_plans: { code: "organizer", name: "Organizer" } }] : [],
    ),
    event_document_requirements: table(
      options.requiredDocument
        ? [{ id: "req-1", event_id: EVENT_ID, template_id: "t-1", template_version_id: null, studio_id: STUDIO_ID, organizer_id: organizerId, active: true, is_required: true, document_templates: { id: "t-1", title: "Waiver", body: "Body", current_version: 1 } }]
        : [],
    ),
    event_ticket_types: table(options.tickets ?? [ticketRow()]),
    event_registrations: table(),
    event_registration_items: table(),
    event_registration_attendees: table(),
    event_order_items: table(),
    event_orders: table(),
    event_private_lesson_slots: table(),
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => createFakeAdminClient(tables) }));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...args: unknown[]) => stripeSessionsCreate(...args) } } }),
}));
vi.mock("@/lib/documents/event-signing", () => ({
  beginEventSigningCheckpoint: (...args: unknown[]) => beginEventSigningCheckpointMock(...args),
}));

const { POST } = await import("@/app/api/events/cart/checkout/route");

type Line = { id: string; quantity: number; expectedCents?: string };

function buildRequest(lines: Line[], extra: Record<string, string> = {}, additionalAttendees: string[] = []) {
  ipCounter += 1;
  const formData = new FormData();
  formData.set("eventSlug", "test-event");
  formData.set("attendeeFirstName", "Taylor");
  formData.set("attendeeLastName", "Attendee");
  formData.set("attendeeEmail", "attendee@example.com");
  for (const line of lines) {
    formData.append("ticketTypeIds", line.id);
    formData.append("ticketQuantities", String(line.quantity));
    if (line.expectedCents !== undefined) formData.append("expectedUnitPriceCents", line.expectedCents);
  }
  for (const name of additionalAttendees) formData.append("additionalAttendeeNames", name);
  for (const [key, value] of Object.entries(extra)) formData.set(key, value);
  return new NextRequest("https://app.example.com/api/events/cart/checkout", {
    method: "POST",
    body: formData,
    headers: { "x-forwarded-for": `10.1.0.${ipCounter}` },
  });
}

type StripeArgs = [
  { line_items: Array<{ quantity: number; price_data: { unit_amount: number } }>; payment_intent_data: { application_fee_amount?: number } },
  unknown,
];
const stripeCall = () => stripeSessionsCreate.mock.calls[0] as unknown as StripeArgs;

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  stripeSessionsCreate = vi.fn().mockResolvedValue({ id: "cs_test_1", url: "https://checkout.stripe.com/session/cs_test_1" });
  beginEventSigningCheckpointMock = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CI-A cart checkout: effective early-bird price is what is stored and charged", () => {
  it("charges the early-bird price before the cutoff, consistently in every snapshot and in Stripe", async () => {
    vi.setSystemTime(CUTOFF_MS - 86_400_000);
    tables = buildTables();
    const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 2, expectedCents: "3000" }], {}, ["Second Guest"]));

    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/session/cs_test_1");
    const order = tables.event_orders.rows[0];
    expect(order).toMatchObject({ subtotal_amount: 60, total_amount: 60 });
    expect(tables.event_registrations.rows[0]).toMatchObject({ unit_price: 30, total_price: 60, total_amount: 60, quantity: 2 });
    expect(tables.event_registration_items.rows[0]).toMatchObject({ unit_price: 30, line_total: 60 });
    expect(tables.event_order_items.rows[0]).toMatchObject({ unit_price: 30, total_price: 60, quantity: 2 });
    expect((tables.event_order_items.rows[0].metadata as Row).pricing).toEqual({
      rule: "effective_ticket_price_v1", unit_cents: 3000, regular_unit_cents: 4000, early_bird: true, early_bird_ends_at: CUTOFF,
    });
    const [session] = stripeCall();
    expect(session.line_items).toEqual([expect.objectContaining({ quantity: 2, price_data: expect.objectContaining({ unit_amount: 3000 }) })]);
    expect(session.payment_intent_data.application_fee_amount).toBeUndefined(); // studio-hosted: no platform fee
  });

  it("NEGATIVE (former overcharge): while early bird is active the regular price is never charged", async () => {
    vi.setSystemTime(CUTOFF_MS - 60_000);
    tables = buildTables();
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    const [session] = stripeCall();
    expect(session.line_items[0].price_data.unit_amount).not.toBe(4000);
    expect(session.line_items[0].price_data.unit_amount).toBe(3000);
    expect(tables.event_orders.rows[0].total_amount).not.toBe(40);
  });

  it("uses the early-bird price one millisecond before the cutoff", async () => {
    vi.setSystemTime(CUTOFF_MS - 1);
    tables = buildTables();
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(3000);
  });

  it("uses the regular price exactly at the cutoff and one millisecond after (for a buyer shown the regular price)", async () => {
    for (const now of [CUTOFF_MS, CUTOFF_MS + 1]) {
      vi.setSystemTime(now);
      tables = buildTables();
      stripeSessionsCreate.mockClear();
      await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "4000" }]));
      expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(4000);
      expect(tables.event_orders.rows[0].total_amount).toBe(40);
      expect((tables.event_order_items.rows[0].metadata as Row).pricing).toMatchObject({ early_bird: false, early_bird_ends_at: null });
    }
  });

  it("prices a mixed cart (early bird + regular) per line in integer cents", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables({ tickets: [ticketRow({ price: "19.99", early_bird_price: "9.99" }), ticketRow({ id: REGULAR_ID, name: "Regular", price: "25.10", early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null })] });
    await POST(buildRequest([{ id: EARLY_ID, quantity: 3, expectedCents: "999" }, { id: REGULAR_ID, quantity: 1, expectedCents: "2510" }], {}, ["Guest 2", "Guest 3"]));
    // 3 x 9.99 + 25.10 = 55.07 exactly (no float drift)
    expect(tables.event_orders.rows[0].total_amount).toBe(55.07);
    const lines = stripeCall()[0].line_items.map((line) => [line.quantity, line.price_data.unit_amount]);
    expect(lines).toEqual([[3, 999], [1, 2510]]);
    expect(tables.event_registrations.rows.map((row) => [row.unit_price, row.total_price])).toEqual([[9.99, 29.97], [25.1, 25.1]]);
  });

  it("organizer-hosted: the platform fee is computed from the charged (early-bird) total, not the regular total", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables({ organizerHosted: true });
    await POST(buildRequest([{ id: EARLY_ID, quantity: 2, expectedCents: "3000" }], {}, ["Guest 2"]));
    const fee = stripeCall()[0].payment_intent_data.application_fee_amount;
    expect(fee).toBe(Math.round(6000 * ORGANIZER_STANDARD_FEE_PERCENT));
    expect(fee).not.toBe(Math.round(8000 * ORGANIZER_STANDARD_FEE_PERCENT));
  });

  it("required documents: the early-bird snapshot is stored before signing (resume charges the stored snapshot)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables({ requiredDocument: true });
    beginEventSigningCheckpointMock.mockResolvedValue({ checkpointId: "cp-1", signingUrl: "https://app.example.com/sign/token" });
    const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    expect(response.headers.get("location")).toBe("https://app.example.com/sign/token");
    expect(stripeSessionsCreate).not.toHaveBeenCalled();
    expect(tables.event_order_items.rows[0]).toMatchObject({ unit_price: 30, total_price: 30 });
    expect(tables.event_orders.rows[0].total_amount).toBe(30);
  });
});

describe("CI-A cart checkout: cutoff race and tampering", () => {
  it("refuses, before writing anything, when the price rose above the one the buyer was shown (cutoff passed)", async () => {
    vi.setSystemTime(CUTOFF_MS); // the buyer opened the page during early bird and saw 30.00
    tables = buildTables();
    const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    expect(response.headers.get("location")).toContain("/events/test-event?error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);
    expect(tables.event_registrations.rows).toHaveLength(0);
    expect(tables.event_order_items.rows).toHaveLength(0);
    expect(stripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("never charges more than shown on any line of a mixed cart", async () => {
    vi.setSystemTime(CUTOFF_MS + 5);
    tables = buildTables({ tickets: [ticketRow(), ticketRow({ id: REGULAR_ID, early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null, price: 25 })] });
    const response = await POST(buildRequest([{ id: REGULAR_ID, quantity: 1, expectedCents: "2500" }, { id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    expect(response.headers.get("location")).toContain("error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);
  });

  it("charges the lower server price if the buyer was shown a higher one (never more than shown)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables();
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "4000" }]));
    expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(3000);
  });

  it("ignores client-supplied prices: a lower 'expected' price is refused, extra price fields are ignored", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables();
    const refused = await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "100" }]));
    expect(refused.headers.get("location")).toContain("error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);

    tables = buildTables();
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1 }], { price: "1", unitPrice: "1", unit_price: "1", total: "1", totalAmount: "1" }));
    expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(3000);
    expect(tables.event_orders.rows[0].total_amount).toBe(30);
  });

  it("the same ticket submitted twice: the LOWEST shown price is the one honoured (refused when exceeded)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables();
    // Merged to quantity 2, so a second attendee name is supplied; the refusal must come from the price check.
    const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }, { id: EARLY_ID, quantity: 1, expectedCents: "2000" }], {}, ["Second Guest"]));
    expect(response.headers.get("location")).toContain("error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);
  });

  it("a malformed expectation is treated as nothing payable (refused, no order)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables();
    const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "12.5" }]));
    expect(response.headers.get("location")).toContain("error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);
  });

  it("older pages without an expectation are charged the effective price (they displayed the higher regular price)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables();
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1 }]));
    expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(3000);
  });
});

describe("CI-A cart checkout: invalid configuration fails safely", () => {
  it("does not sell a ticket whose regular price is invalid (no invented amount, nothing written)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    for (const price of [-5, "abc", "12.345", null]) {
      tables = buildTables({ tickets: [ticketRow({ price, early_bird_enabled: false })] });
      const response = await POST(buildRequest([{ id: EARLY_ID, quantity: 1 }]));
      expect(response.headers.get("location"), String(price)).toContain("error=ticket_unavailable");
      expect(tables.event_orders.rows).toHaveLength(0);
    }
    expect(stripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("charges the regular price when an enabled early bird is not lower than the regular price", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables({ tickets: [ticketRow({ early_bird_price: 45 })] });
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "4000" }]));
    expect(stripeCall()[0].line_items[0].price_data.unit_amount).toBe(4000);
  });
});

describe("CI-A cart checkout: per-line fields stay paired by position", () => {
  it("buys BOTH tickets when two different tickets have the same quantity (was silently dropping the second)", async () => {
    vi.setSystemTime(CUTOFF_MS - 1000);
    tables = buildTables({ tickets: [ticketRow(), ticketRow({ id: REGULAR_ID, name: "Regular", price: 25, early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null })] });
    await POST(buildRequest([{ id: EARLY_ID, quantity: 1, expectedCents: "3000" }, { id: REGULAR_ID, quantity: 1, expectedCents: "2500" }]));
    expect(tables.event_registrations.rows.map((row) => row.ticket_type_id)).toEqual([EARLY_ID, REGULAR_ID]);
    expect(tables.event_orders.rows[0].total_amount).toBe(55);
    expect(stripeCall()[0].line_items.map((line) => [line.quantity, line.price_data.unit_amount])).toEqual([[1, 3000], [1, 2500]]);
  });

  it("keeps equal expected prices aligned with their own lines", async () => {
    vi.setSystemTime(CUTOFF_MS + 1);
    tables = buildTables({ tickets: [ticketRow({ id: REGULAR_ID, price: 30, early_bird_enabled: false, early_bird_price: null, early_bird_ends_at: null }), ticketRow()] });
    // Both lines were shown 30.00; the early-bird line is now 40.00 -> must be refused even though the values repeat.
    const response = await POST(buildRequest([{ id: REGULAR_ID, quantity: 1, expectedCents: "3000" }, { id: EARLY_ID, quantity: 1, expectedCents: "3000" }]));
    expect(response.headers.get("location")).toContain("error=ticket_price_changed");
    expect(tables.event_orders.rows).toHaveLength(0);
  });
});
