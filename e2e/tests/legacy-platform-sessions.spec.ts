import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import { cleanupStripeTestModeFixture, createStripeTestModeFixture, type StripeTestModeFixture } from "../helpers/stripeTestModeFixture";

/**
 * PAY-WH-1B -- legacy platform-account Checkout Sessions against REAL Stripe test mode.
 *
 * Reproduces the production situation: event cart orders created before the 2026-07-16 direct-charge cutover stored a
 * Checkout Session that lives on the PLATFORM account (destination charge to the studio's connected account). Set-up
 * (labelled): such Sessions are created on the platform account with the exact legacy metadata, and a pre-cutover pending
 * order referencing each is written directly to the isolated QA database (no payment attempt row, lapsed hold) -- the
 * state PAY-WH-1 found in production. The real reconcile sweeper then runs.
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "";

test.describe("PAY-WH-1B legacy platform-account Sessions (real Stripe test mode)", () => {
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT) || !CRON_SECRET, "Stripe TEST key, test connected account and local cron secret not provided");
  let config: E2EConfig;
  let fixture: StripeTestModeFixture;
  let stripe: Stripe;
  const admin = () => e2eAdminClient(config);

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createStripeTestModeFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (!fixture || process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupStripeTestModeFixture(config, fixture);
  });

  async function runCron() {
    const response = await fetch(`${config.baseUrl}/api/cron/event-cart-orders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<{ outcomes: Record<string, number> }>;
  }

  /** Set-up: a pre-cutover pending order (lapsed hold, no attempt row) with one pending registration. */
  async function legacyOrder(tag: string, options: { createdAt?: string } = {}) {
    const orderId = randomUUID();
    await admin().from("event_orders").insert({
      id: orderId, event_id: fixture.events.orgEarly.id, studio_id: fixture.studioId, buyer_name: "Legacy Buyer",
      buyer_email: `e2e-legacy-${fixture.runId}-${tag}@example.com`, subtotal_amount: 25, total_amount: 25, currency: "USD",
      status: "pending", payment_status: "pending", expires_at: "2026-06-10T13:00:00Z", created_at: options.createdAt ?? "2026-06-10T12:30:00Z",
      metadata: { source: "event_cart_v1" },
    }).throwOnError();
    await admin().from("event_registrations").insert({
      order_id: orderId, event_id: fixture.events.orgEarly.id, ticket_type_id: fixture.tickets.regular, studio_id: fixture.studioId,
      status: "pending", payment_status: "pending", quantity: 1, unit_price: 25, total_price: 25, currency: "USD", registration_source: "public_event_page",
      attendee_first_name: "Legacy", attendee_last_name: tag, attendee_email: `e2e-legacy-${fixture.runId}-${tag}@example.com`,
    }).throwOnError();
    return orderId;
  }

  /** Set-up: the pre-cutover checkout -- a destination-charge Session on the PLATFORM account with the legacy metadata. */
  async function platformSession(orderId: string, metadataOverrides: Record<string, string> = {}) {
    const metadata = { source: "event_cart_order", studio_id: fixture.studioId, event_id: fixture.events.orgEarly.id, order_id: orderId, connected_account_id: ACCOUNT, ...metadataOverrides };
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: `e2e-legacy-${fixture.runId}@example.com`,
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/cancel",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 2500, product_data: { name: "Legacy ticket (test mode)" } } }],
      payment_intent_data: { transfer_data: { destination: ACCOUNT }, metadata },
      metadata,
    });
    await admin().from("event_orders").update({ stripe_checkout_session_id: session.id }).eq("id", orderId).throwOnError();
    await admin().from("event_registrations").update({ stripe_checkout_session_id: session.id }).eq("order_id", orderId).throwOnError();
    return session;
  }

  async function payOnPlatform(sessionId: string) {
    const page = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {})) as unknown as { total_summary?: { due?: number } };
    const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, billing_details: { name: "Legacy Buyer", email: `e2e-legacy-${fixture.runId}@example.com` } });
    await stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: pm.id, expected_amount: page.total_summary?.due });
  }

  async function orderState(orderId: string) {
    const { data } = await admin().from("event_orders").select("status, payment_status, settlement_state, paid_at").eq("id", orderId).single();
    const { data: regs } = await admin().from("event_registrations").select("status, payment_status").eq("order_id", orderId);
    const { data: attempts } = await admin().from("event_order_payment_attempts").select("surface, status").eq("order_id", orderId);
    return { order: data, registrations: regs, attempts };
  }

  test("L1 an EXPIRED platform Session: the legacy order is released normally (once)", async () => {
    const orderId = await legacyOrder("l1");
    const session = await platformSession(orderId);
    await stripe.checkout.sessions.expire(session.id); // set-up: months-old Session (Stripe expires them after 24h)
    await runCron();
    expect(await orderState(orderId)).toEqual({
      order: { status: "expired", payment_status: "failed", settlement_state: "expired", paid_at: null },
      registrations: [{ status: "cancelled", payment_status: "failed" }],
      attempts: [{ surface: "legacy", status: "closed" }],
    });
    await runCron(); // replay: nothing changes
    expect((await orderState(orderId)).order).toMatchObject({ status: "expired", settlement_state: "expired" });
  });

  test("L2 an OPEN platform Session is verified, expired ON THE PLATFORM by the sweeper, then the order is released", async () => {
    const orderId = await legacyOrder("l2");
    const session = await platformSession(orderId);
    await runCron();
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe("expired");
    expect((await orderState(orderId)).order).toMatchObject({ status: "expired", payment_status: "failed", settlement_state: "expired" });
  });

  test("L3 a PAID platform Session is never mistaken for an unpaid expired one: no release, no settlement, captured-payment exception", async () => {
    const orderId = await legacyOrder("l3");
    const session = await platformSession(orderId);
    await payOnPlatform(session.id);
    const paid = await stripe.checkout.sessions.retrieve(session.id);
    expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
    await runCron();
    const state = await orderState(orderId);
    expect(state.order).toMatchObject({ status: "pending", payment_status: "pending", paid_at: null }); // never released, never settled
    expect(state.order?.settlement_state).not.toBe("expired");
    expect(state.registrations).toEqual([{ status: "pending", payment_status: "pending" }]);
    const { data: exceptions } = await admin().from("event_order_settlement_exceptions")
      .select("kind, money_state, status, alert_status, stripe_checkout_session_id, stripe_payment_intent_id, amount_cents, stripe_account_id").eq("order_id", orderId);
    expect(exceptions).toEqual([expect.objectContaining({
      kind: "mismatch_account", money_state: "captured", status: "open", stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: String(paid.payment_intent), amount_cents: 2500, stripe_account_id: "platform:legacy_destination_charge",
    })]);
    expect(["pending", "sent"]).toContain(exceptions![0].alert_status);
    expect((await stripe.refunds.list({ payment_intent: String(paid.payment_intent) })).data).toEqual([]); // nothing refunded
    const { data: payments } = await admin().from("event_payments").select("id").eq("stripe_payment_intent_id", String(paid.payment_intent));
    expect(payments).toEqual([]);
  });

  test("L4 control -- a NON-legacy order (created after the cutover) is never looked up on the platform account", async () => {
    const orderId = await legacyOrder("l4", { createdAt: new Date().toISOString() });
    const session = await platformSession(orderId);
    await runCron();
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe("open"); // untouched
    const state = await orderState(orderId);
    expect(state.order).toMatchObject({ status: "pending", payment_status: "pending" });
    expect(state.order?.settlement_state).not.toBe("expired");
    await stripe.checkout.sessions.expire(session.id); // test-mode cleanup of the control Session
  });

  test("L5 a platform Session whose metadata names ANOTHER order is never expired or used", async () => {
    const orderId = await legacyOrder("l5");
    const session = await platformSession(orderId, { order_id: randomUUID() });
    await runCron();
    expect((await stripe.checkout.sessions.retrieve(session.id)).status).toBe("open");
    expect((await orderState(orderId)).order).toMatchObject({ status: "pending", payment_status: "pending" });
    await stripe.checkout.sessions.expire(session.id);
  });

  test("L6 concurrency -- two sweeper runs racing on legacy orders release the open one exactly once and record the paid one once", async () => {
    const openOrder = await legacyOrder("l6-open");
    const openSession = await platformSession(openOrder);
    const paidOrder = await legacyOrder("l6-paid");
    const paidSession = await platformSession(paidOrder);
    await payOnPlatform(paidSession.id);
    await Promise.all([runCron(), runCron()]);
    expect((await orderState(openOrder)).order).toMatchObject({ status: "expired", settlement_state: "expired" });
    expect((await orderState(openOrder)).attempts).toEqual([{ surface: "legacy", status: "closed" }]);
    expect((await stripe.checkout.sessions.retrieve(openSession.id)).status).toBe("expired");
    expect((await orderState(paidOrder)).order).toMatchObject({ status: "pending", payment_status: "pending", paid_at: null });
    const { data: exceptions } = await admin().from("event_order_settlement_exceptions").select("kind").eq("order_id", paidOrder);
    expect(exceptions).toEqual([{ kind: "mismatch_account" }]);
  });
});
