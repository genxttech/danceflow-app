import { describe, expect, it, vi, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient, type Row } from "@/lib/payments/__tests__/fakeSupabase";
import type { NextRequest } from "next/server";

/**
 * Regression coverage for the Payments P1.2 event-ticket checkout
 * idempotency tranche:
 *  - resolveEventOrderForCheckout (order-creation dedupe on
 *    (studio_id, client_request_id), mirroring
 *    src/lib/payments/terminal-quick-charge.ts's resolveAdHocPayment from
 *    Payments P0.1);
 *  - startEventOrderPayment's pre-existing retrieve-or-create Stripe logic,
 *    which the checkout route now delegates to for BOTH new and reused
 *    orders instead of duplicating Stripe calls itself -- this is what
 *    actually makes PaymentIntent/Checkout Session creation idempotent.
 */

let ordersTable: FakeTable;
let itemsTable: FakeTable;
let registrationsTable: FakeTable;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    createFakeAdminClient({
      event_orders: ordersTable,
      event_order_items: itemsTable,
      event_registrations: registrationsTable,
    }),
}));

type FakePaymentIntent = { id: string; status: string; client_secret: string };
type FakeSession = { id: string; status: string; url: string };

/**
 * Models real Stripe idempotency-key semantics closely enough to catch a
 * regression to a flat (non-attempt-numbered) key: a create() call reusing
 * a previously-seen idempotency key returns the *cached* response from the
 * original call -- a separate, frozen snapshot, decoupled from whatever
 * the "live" object (looked up via retrieve()) has since transitioned to
 * (e.g. canceled). This is exactly the gap attempt-numbering closes: a
 * flat key would make a genuine retry-after-cancellation silently receive
 * the stale original response instead of a real new object.
 */
function createFakeStripe() {
  let piCounter = 0;
  let sessionCounter = 0;
  const paymentIntents = new Map<string, FakePaymentIntent>();
  const sessions = new Map<string, FakeSession>();
  const createCalls: { idempotencyKey?: string }[] = [];
  const sessionCreateCalls: { idempotencyKey?: string }[] = [];
  const paymentIntentIdempotencyCache = new Map<string, FakePaymentIntent>();
  const sessionIdempotencyCache = new Map<string, FakeSession>();

  const stripe = {
    paymentIntents: {
      create: vi.fn(async (_params: unknown, requestOptions: { idempotencyKey?: string }) => {
        const key = requestOptions?.idempotencyKey;
        if (key && paymentIntentIdempotencyCache.has(key)) {
          createCalls.push({ idempotencyKey: key });
          return paymentIntentIdempotencyCache.get(key)!;
        }
        piCounter += 1;
        const pi: FakePaymentIntent = {
          id: `pi_${piCounter}`,
          status: "requires_payment_method",
          client_secret: `secret_${piCounter}`,
        };
        paymentIntents.set(pi.id, pi);
        if (key) paymentIntentIdempotencyCache.set(key, { ...pi });
        createCalls.push({ idempotencyKey: key });
        return pi;
      }),
      retrieve: vi.fn(async (id: string) => {
        const pi = paymentIntents.get(id);
        if (!pi) throw new Error(`Unknown PaymentIntent ${id}`);
        return pi;
      }),
    },
    checkout: {
      sessions: {
        create: vi.fn(async (_params: unknown, requestOptions: { idempotencyKey?: string }) => {
          const key = requestOptions?.idempotencyKey;
          if (key && sessionIdempotencyCache.has(key)) {
            sessionCreateCalls.push({ idempotencyKey: key });
            return sessionIdempotencyCache.get(key)!;
          }
          sessionCounter += 1;
          const session: FakeSession = {
            id: `cs_${sessionCounter}`,
            status: "open",
            url: `https://checkout.stripe.com/cs_${sessionCounter}`,
          };
          sessions.set(session.id, session);
          if (key) sessionIdempotencyCache.set(key, { ...session });
          sessionCreateCalls.push({ idempotencyKey: key });
          return session;
        }),
        retrieve: vi.fn(async (id: string) => {
          const session = sessions.get(id);
          if (!session) throw new Error(`Unknown session ${id}`);
          return session;
        }),
      },
    },
  };

  return { stripe, paymentIntents, sessions, createCalls, sessionCreateCalls };
}

let currentFakeStripe: ReturnType<typeof createFakeStripe>;

vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => currentFakeStripe.stripe,
}));

const { computeTicketSelectionSignature, resolveEventOrderForCheckout, startEventOrderPayment } = await import(
  "@/lib/events/event-order-payment"
);

const STUDIO_ID = "studio-1";
const EVENT_ID = "event-1";

function seedOrder(overrides: Row = {}) {
  const row: Row = {
    id: `order-${ordersTable.rows.length + 1}`,
    event_id: EVENT_ID,
    studio_id: STUDIO_ID,
    organizer_id: null,
    buyer_email: "buyer@example.com",
    total_amount: 20,
    currency: "usd",
    status: "pending",
    payment_status: "pending",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    events: { id: EVENT_ID, slug: "spring-showcase", name: "Spring Showcase" },
    studios: {
      stripe_connected_account_id: "acct_1",
      stripe_connect_charges_enabled: true,
      stripe_connect_payouts_enabled: true,
      stripe_connect_onboarding_complete: true,
    },
    metadata: {},
    ...overrides,
  };
  ordersTable.rows.push(row);
  return row;
}

function fakeRequest(): NextRequest {
  return { nextUrl: { origin: "https://app.example.com" } } as unknown as NextRequest;
}

beforeEach(() => {
  ordersTable = new FakeTable();
  ordersTable.uniqueColumns = ["studio_id", "client_request_id"];
  itemsTable = new FakeTable();
  registrationsTable = new FakeTable();
  currentFakeStripe = createFakeStripe();
});

const TWO_GA_TICKETS = [{ ticketTypeId: "ticket-ga", quantity: 2 }];
const TWO_GA_TICKETS_SIGNATURE = computeTicketSelectionSignature(TWO_GA_TICKETS);

describe("computeTicketSelectionSignature", () => {
  it("produces the same signature regardless of submission order", () => {
    const a = computeTicketSelectionSignature([
      { ticketTypeId: "ticket-ga", quantity: 2 },
      { ticketTypeId: "ticket-vip", quantity: 1 },
    ]);
    const b = computeTicketSelectionSignature([
      { ticketTypeId: "ticket-vip", quantity: 1 },
      { ticketTypeId: "ticket-ga", quantity: 2 },
    ]);
    expect(a).toBe(b);
  });

  it("produces a different signature for a different ticket-type composition", () => {
    const twoGa = computeTicketSelectionSignature([{ ticketTypeId: "ticket-ga", quantity: 2 }]);
    const oneVip = computeTicketSelectionSignature([{ ticketTypeId: "ticket-vip", quantity: 1 }]);
    expect(twoGa).not.toBe(oneVip);
  });
});

describe("resolveEventOrderForCheckout", () => {
  const baseParams = {
    studioId: STUDIO_ID,
    eventId: EVENT_ID,
    requestedTotalCents: 2000,
    ticketSelectionSignature: TWO_GA_TICKETS_SIGNATURE,
    insertPayload: {
      organizer_id: null,
      buyer_name: "Jamie Lee",
      buyer_email: "jamie@example.com",
      buyer_phone: null,
      buyer_notes: null,
      subtotal_amount: 0,
      total_amount: 0,
      currency: "usd",
      status: "pending",
      payment_status: "pending",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: {
        source: "test",
        requested_total_cents: 2000,
        ticket_selection_signature: TWO_GA_TICKETS_SIGNATURE,
      },
    },
  };

  it("creates a new order for a first-time clientRequestId", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });
    const result = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isNew).toBe(true);
    expect(ordersTable.rows).toHaveLength(1);
  });

  it("reuses the same order for the same clientRequestId without inserting a second row", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    const first = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
    });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.order.id).toBe(first.order.id);
      expect(second.isNew).toBe(false);
    }
    expect(ordersTable.rows).toHaveLength(1);
  });

  it("creates distinct orders for different clientRequestIds", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    const first = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
    });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-b",
      ...baseParams,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.order.id).not.toBe(first.order.id);
    }
    expect(ordersTable.rows).toHaveLength(2);
  });

  it("recovers from a concurrent duplicate insert (Postgres 23505) by reusing the winning row", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    // Simulate a genuine race: another request's INSERT commits between
    // this request's pre-check SELECT (which sees nothing) and its own
    // INSERT.
    ordersTable.raceOnNextInsert = (payload) => {
      ordersTable.rows.push({
        id: "winner-order",
        status: "pending",
        created_at: "t0",
        event_id: payload.event_id,
        studio_id: payload.studio_id,
        client_request_id: payload.client_request_id,
        payment_status: "pending",
        metadata: {
          requested_total_cents: baseParams.requestedTotalCents,
          ticket_selection_signature: baseParams.ticketSelectionSignature,
        },
      });
    };

    const result = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.id).toBe("winner-order");
      expect(result.isNew).toBe(false);
    }
  });

  it("rejects reuse when the requested amount differs from the original attempt", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    await resolveEventOrderForCheckout({ supabase: supabase as never, clientRequestId: "req-a", ...baseParams });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
      requestedTotalCents: 5000,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/different checkout amount/);
  });

  it("rejects reuse when the event differs from the original attempt", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    await resolveEventOrderForCheckout({ supabase: supabase as never, clientRequestId: "req-a", ...baseParams });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
      eventId: "different-event",
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/different event checkout/);
  });

  it("allows reuse when the exact same ticket mix is submitted (an exact retry)", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });

    const first = await resolveEventOrderForCheckout({ supabase: supabase as never, clientRequestId: "req-a", ...baseParams });
    const second = await resolveEventOrderForCheckout({ supabase: supabase as never, clientRequestId: "req-a", ...baseParams });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.order.id).toBe(first.order.id);
    expect(ordersTable.rows).toHaveLength(1);
  });

  it("allows reuse when the same ticket mix is submitted in a different order", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });
    const mix = [
      { ticketTypeId: "ticket-ga", quantity: 2 },
      { ticketTypeId: "ticket-vip", quantity: 1 },
    ];
    const shuffledMix = [
      { ticketTypeId: "ticket-vip", quantity: 1 },
      { ticketTypeId: "ticket-ga", quantity: 2 },
    ];
    // Both submissions normalize to the identical signature -- this is
    // exactly what computeTicketSelectionSignature exists to guarantee, so
    // the stored signature (written into insertPayload.metadata on the
    // first, order-creating call) matches the second call's freshly
    // computed signature even though the raw arrays differ in order.
    const signature = computeTicketSelectionSignature(mix);
    expect(signature).toBe(computeTicketSelectionSignature(shuffledMix));

    const params = {
      ...baseParams,
      ticketSelectionSignature: signature,
      insertPayload: {
        ...baseParams.insertPayload,
        metadata: { ...baseParams.insertPayload.metadata, ticket_selection_signature: signature },
      },
    };

    const first = await resolveEventOrderForCheckout({ supabase: supabase as never, clientRequestId: "req-a", ...params });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...params,
      ticketSelectionSignature: computeTicketSelectionSignature(shuffledMix),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.order.id).toBe(first.order.id);
    expect(ordersTable.rows).toHaveLength(1);
  });

  it("rejects reuse when the ticket composition differs even at the same total", async () => {
    const supabase = createFakeAdminClient({ event_orders: ordersTable });
    // Same aggregate price ($20), genuinely different tickets: 2x$10 GA
    // vs. 1x$20 VIP -- the amount check alone would not catch this.
    const twoGaTickets = [{ ticketTypeId: "ticket-ga", quantity: 2 }];
    const oneVipTicket = [{ ticketTypeId: "ticket-vip", quantity: 1 }];

    await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
      ticketSelectionSignature: computeTicketSelectionSignature(twoGaTickets),
    });
    const second = await resolveEventOrderForCheckout({
      supabase: supabase as never,
      clientRequestId: "req-a",
      ...baseParams,
      ticketSelectionSignature: computeTicketSelectionSignature(oneVipTicket),
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/different ticket selection/);
  });
});

describe("startEventOrderPayment", () => {
  it("returns completed:true without any Stripe call when the order is already paid", async () => {
    const order = seedOrder({ status: "confirmed", payment_status: "paid" });
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(result.completed).toBe(true);
    expect(result.registrationIds).toEqual(["reg-1"]);
    expect(currentFakeStripe.createCalls).toHaveLength(0);
  });

  it("completes a free order without any Stripe call", async () => {
    const order = seedOrder({ total_amount: 0 });
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(result.completed).toBe(true);
    expect(currentFakeStripe.createCalls).toHaveLength(0);

    const updated = ordersTable.rows.find((r) => r.id === order.id);
    expect(updated?.status).toBe("confirmed");
    expect(updated?.payment_status).toBe("paid");
  });

  it("creates a new PaymentIntent with an attempt-numbered idempotency key", async () => {
    const order = seedOrder();
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(result.clientSecret).toBeDefined();
    expect(currentFakeStripe.createCalls).toHaveLength(1);
    expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(`event-order:${order.id}:payment-intent:0`);

    const updated = ordersTable.rows.find((r) => r.id === order.id);
    expect((updated?.metadata as Record<string, unknown>)?.payment_intent_attempt_count).toBe(1);
  });

  it("uses a different idempotency key on a genuine retry after cancellation -- does not replay the original creation's cached response", async () => {
    const order = seedOrder();
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const first = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    // Simulate the PaymentIntent from the first attempt being canceled
    // server-side (e.g. reader/confirmation failure) before a retry.
    const orderAfterFirst = ordersTable.rows.find((r) => r.id === order.id)!;
    const firstIntentId = orderAfterFirst.stripe_payment_intent_id as string;
    currentFakeStripe.paymentIntents.get(firstIntentId)!.status = "canceled";

    const second = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(currentFakeStripe.createCalls).toHaveLength(2);
    expect(currentFakeStripe.createCalls[0].idempotencyKey).toBe(`event-order:${order.id}:payment-intent:0`);
    expect(currentFakeStripe.createCalls[1].idempotencyKey).toBe(`event-order:${order.id}:payment-intent:1`);
    expect(currentFakeStripe.createCalls[0].idempotencyKey).not.toBe(currentFakeStripe.createCalls[1].idempotencyKey);
    // A genuinely new object -- not Stripe's cached response for the first
    // (now-canceled) attempt's idempotency key, which the fake would have
    // returned had the second call reused the same key.
    expect(second.clientSecret).not.toBe(first.clientSecret);
    expect(second.clientSecret).toBeDefined();
  });

  it("reuses an existing live PaymentIntent instead of creating a second one", async () => {
    const order = seedOrder({ stripe_payment_intent_id: "pi_existing" });
    currentFakeStripe.paymentIntents.set("pi_existing", {
      id: "pi_existing",
      status: "requires_payment_method",
      client_secret: "secret_existing",
    });
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(result.clientSecret).toBe("secret_existing");
    expect(currentFakeStripe.createCalls).toHaveLength(0);
    expect(currentFakeStripe.stripe.paymentIntents.retrieve).toHaveBeenCalledWith(
      "pi_existing",
      {},
      expect.objectContaining({ stripeAccount: "acct_1" }),
    );
  });

  it("mints a fresh PaymentIntent when the existing one was canceled -- does not replay a stale object", async () => {
    const order = seedOrder({ stripe_payment_intent_id: "pi_canceled" });
    currentFakeStripe.paymentIntents.set("pi_canceled", {
      id: "pi_canceled",
      status: "canceled",
      client_secret: "secret_canceled",
    });
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "payment_sheet",
    });

    expect(currentFakeStripe.createCalls).toHaveLength(1);
    expect(result.clientSecret).not.toBe("secret_canceled");
  });

  it("creates a checkout session with an attempt-numbered idempotency key", async () => {
    const order = seedOrder();
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "checkout",
    });

    expect(result.checkoutUrl).toBeDefined();
    expect(currentFakeStripe.sessionCreateCalls).toHaveLength(1);
    expect(currentFakeStripe.sessionCreateCalls[0].idempotencyKey).toBe(`event-order:${order.id}:checkout-session:0`);

    const updated = ordersTable.rows.find((r) => r.id === order.id);
    expect((updated?.metadata as Record<string, unknown>)?.checkout_session_attempt_count).toBe(1);
  });

  it("reuses an existing open checkout session instead of creating a second one", async () => {
    const order = seedOrder({ stripe_checkout_session_id: "cs_existing" });
    currentFakeStripe.sessions.set("cs_existing", {
      id: "cs_existing",
      status: "open",
      url: "https://checkout.stripe.com/cs_existing",
    });
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const result = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "checkout",
    });

    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/cs_existing");
    expect(currentFakeStripe.sessionCreateCalls).toHaveLength(0);
  });

  it("uses a different idempotency key on a genuine retry after the session is no longer open -- does not replay the original creation's cached response", async () => {
    const order = seedOrder();
    registrationsTable.rows.push({ id: "reg-1", order_id: order.id });
    itemsTable.rows.push({ order_id: order.id, quantity: 1, unit_price: 20, description: "GA Ticket" });

    const first = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "checkout",
    });

    // Simulate the first session expiring/completing before a retry.
    const orderAfterFirst = ordersTable.rows.find((r) => r.id === order.id)!;
    const firstSessionId = orderAfterFirst.stripe_checkout_session_id as string;
    currentFakeStripe.sessions.get(firstSessionId)!.status = "expired";

    const second = await startEventOrderPayment({
      request: fakeRequest(),
      orderId: order.id as string,
      surface: "student_app",
      paymentMode: "checkout",
    });

    expect(currentFakeStripe.sessionCreateCalls).toHaveLength(2);
    expect(currentFakeStripe.sessionCreateCalls[0].idempotencyKey).toBe(`event-order:${order.id}:checkout-session:0`);
    expect(currentFakeStripe.sessionCreateCalls[1].idempotencyKey).toBe(`event-order:${order.id}:checkout-session:1`);
    expect(second.checkoutUrl).not.toBe(first.checkoutUrl);
    expect(second.checkoutUrl).toBeDefined();
  });
});
