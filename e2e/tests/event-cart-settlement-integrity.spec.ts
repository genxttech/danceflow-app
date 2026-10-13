import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { e2eAdminClient } from "../helpers/competitionFixture";
import {
  cleanupStripeTestModeFixture,
  createStripeTestModeFixture,
  readEventPurchase,
  studentAccessToken,
  type StripeTestModeFixture,
} from "../helpers/stripeTestModeFixture";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";
import { signIn } from "../helpers/competitionWizard";

/**
 * PAY-WH-1 -- event cart settlement integrity against REAL Stripe test mode and REAL signed webhooks
 * (environment: docs/qa/local-e2e-environment.md; local app + isolated local QA Supabase + `stripe listen`).
 *
 * Sessions are paid the way Stripe's CLI completes test sessions (payment_pages confirm with tok_visa); the hosted
 * page is never automated. Database-side states that cannot be produced through Stripe alone (a release whose Stripe
 * expiry failed; an interrupted outbox worker) are set up explicitly and labelled as such.
 * Delayed (ACH) payment methods are not enabled on the test account -> covered by the Postgres suites, not here.
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const CRON_SECRET = process.env.E2E_CRON_SECRET ?? "";

test.describe("PAY-WH-1 event cart settlement integrity (real Stripe test mode)", () => {
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT) || !CRON_SECRET, "Stripe TEST key, test connected account and local cron secret not provided");
  let config: E2EConfig;
  let fixture: StripeTestModeFixture;
  let stripe: Stripe;
  const onAccount = { stripeAccount: ACCOUNT };

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createStripeTestModeFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true" || !fixture) return;
    await e2eAdminClient(config).from("event_order_settlement_exceptions").delete().eq("studio_id", fixture.studioId);
    await cleanupStripeTestModeFixture(config, fixture);
  });

  const admin = () => e2eAdminClient(config);
  const cartForm = (page: Page) => page.locator('form[action="/api/events/cart/checkout"]').filter({ visible: true }).first();

  async function buyEarlyBird(page: Page, tag: string) {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.orgEarly.slug}`);
    await page.getByText("Open Registration Form").click();
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.earlyBird}"]`).fill("1");
    const form = cartForm(page);
    await form.locator('input[name="attendeeFirstName"]').fill("Pat");
    await form.locator('input[name="attendeeLastName"]').fill("Buyer");
    await form.locator('input[name="attendeeEmail"]').fill(`e2e-stripe-${fixture.runId}-${tag}@example.com`);
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    const { data } = await admin()
      .from("event_orders")
      .select("id, stripe_checkout_session_id, expires_at, metadata")
      .eq("buyer_email", `e2e-stripe-${fixture.runId}-${tag}@example.com`)
      .single();
    expect(page.url()).toContain(String(data?.stripe_checkout_session_id));
    // PAY-WH-1A: the initial release accepts card payments only (verified on the real Stripe object).
    const session = await stripe.checkout.sessions.retrieve(String(data?.stripe_checkout_session_id), {}, onAccount);
    expect(session.payment_method_types).toEqual(["card"]);
    return data as { id: string; stripe_checkout_session_id: string; expires_at: string; metadata: { holdToken: string } };
  }

  async function payCheckoutSession(sessionId: string) {
    const paymentPage = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {}, onAccount)) as unknown as { total_summary?: { due?: number } };
    const session = await stripe.checkout.sessions.retrieve(sessionId, {}, onAccount);
    const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, billing_details: { name: "Pat Buyer", email: session.customer_email ?? undefined } }, onAccount);
    return stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: pm.id, expected_amount: paymentPage.total_summary?.due }, onAccount);
  }

  async function order(id: string) {
    const { data } = await admin()
      .from("event_orders")
      .select("id, status, payment_status, settlement_state, paid_at, stripe_payment_intent_id, stripe_checkout_session_id, total_amount")
      .eq("id", id)
      .single();
    return data as Record<string, unknown>;
  }

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 90_000) {
    let value = await read();
    const end = Date.now() + timeout;
    while (!done(value) && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      value = await read();
    }
    return value;
  }

  async function ledgerFor(objectIds: string[], since: number) {
    const events = await stripe.events.list({ created: { gte: since }, limit: 100 }, onAccount);
    const relevant = events.data.filter((event) => objectIds.includes((event.data.object as { id: string }).id));
    const { data } = await admin()
      .from("payment_provider_events")
      .select("provider_event_id, event_type, status, error_message")
      .in("provider_event_id", relevant.map((event) => event.id));
    return { events: relevant, ledger: (data ?? []) as Array<Record<string, unknown>> };
  }

  async function runCron() {
    const response = await fetch(`${config.baseUrl}/api/cron/event-cart-orders`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
    expect(response.status).toBe(200);
    return response.json() as Promise<Record<string, unknown>>;
  }

  test("S1 web checkout: both settlement events processed with ZERO failed deliveries; concurrent replay changes nothing", async ({ page }) => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const created = await buyEarlyBird(page, "s1");
    await payCheckoutSession(created.stripe_checkout_session_id);
    const paid = await waitFor(() => order(created.id), (o) => o.payment_status === "paid");
    expect(paid).toMatchObject({ status: "confirmed", settlement_state: "paid" });
    const paymentIntentId = String(paid.stripe_payment_intent_id);

    // Wait until Stripe has delivered both settlement events, in whatever order it chose.
    const both = await waitFor(
      () => ledgerFor([created.stripe_checkout_session_id, paymentIntentId], since),
      ({ ledger }) => ["checkout.session.completed", "payment_intent.succeeded"].every((type) => ledger.some((row) => row.event_type === type && row.status === "processed")),
    );
    const settlementRows = both.ledger.filter((row) => ["checkout.session.completed", "payment_intent.succeeded"].includes(String(row.event_type)));
    expect(settlementRows.every((row) => row.status === "processed")).toBe(true);
    expect(both.ledger.filter((row) => row.status === "failed")).toEqual([]);

    const before = await readEventPurchase(config, fixture.events.orgEarly.id);
    const mine = (rows: Record<string, unknown>[]) => rows.filter((row) => row.order_id === created.id || row.id === created.id);
    const paymentsBefore = before.payments.filter((p) => p.stripe_payment_intent_id === paymentIntentId);

    // Concurrent re-delivery of both authentic events (as `stripe events resend`).
    const replay = both.events.filter((event) => ["checkout.session.completed", "payment_intent.succeeded"].includes(event.type));
    await Promise.all(replay.flatMap((event) => [1, 2].map(() => stripe.rawRequest("POST", `/v1/events/${event.id}/retry`, { for_stripecli: "true", account: ACCOUNT }))));
    await page.waitForTimeout(10_000);

    const after = await order(created.id);
    expect(after.paid_at).toBe(paid.paid_at);
    expect(after.total_amount).toBe(paid.total_amount);
    const purchaseAfter = await readEventPurchase(config, fixture.events.orgEarly.id);
    expect(purchaseAfter.payments.filter((p) => p.stripe_payment_intent_id === paymentIntentId)).toHaveLength(paymentsBefore.length);
    expect(mine(purchaseAfter.registrations).length).toBe(mine(before.registrations).length);
    const { data: exceptions } = await admin().from("event_order_settlement_exceptions").select("kind").eq("order_id", created.id);
    expect(exceptions ?? []).toEqual([]);
    const { data: confirmations } = await admin().from("outbound_deliveries").select("id").eq("dedupe_key", `event_cart_order_confirmed:email:${created.id}`);
    expect(confirmations ?? []).toHaveLength(1);
    const { data: attempts } = await admin().from("event_order_payment_attempts").select("status, stripe_payment_intent_id").eq("order_id", created.id);
    expect(attempts).toEqual([{ status: "succeeded", stripe_payment_intent_id: paymentIntentId }]);
    test.info().annotations.push({ type: "evidence", description: JSON.stringify({ order: created.id, session: created.stripe_checkout_session_id, paymentIntent: paymentIntentId, paid_at: paid.paid_at, ledger: settlementRows }) });
  });

  test("S2 cancel before payment: Stripe Session expired by the app, order released once, the Session can no longer be paid", async ({ page }) => {
    const created = await buyEarlyBird(page, "s2");
    await page.goto(`/api/events/cart/release?orderId=${created.id}&eventSlug=${fixture.events.orgEarly.slug}&holdToken=${created.metadata.holdToken}`);
    await page.waitForURL(/error=checkout_cancelled/, { timeout: 60_000 });
    expect(await order(created.id)).toMatchObject({ status: "cancelled", payment_status: "failed", settlement_state: "released" });
    const session = await stripe.checkout.sessions.retrieve(created.stripe_checkout_session_id, {}, onAccount);
    expect(session.status).toBe("expired");
    await expect(payCheckoutSession(created.stripe_checkout_session_id)).rejects.toThrow();
    const purchase = await readEventPurchase(config, fixture.events.orgEarly.id);
    expect(purchase.registrations.filter((r) => r.order_id === created.id).every((r) => r.status === "cancelled")).toBe(true);
  });

  test("S3 cancel while the payment succeeds: the release finds the payment and the order is paid, never cancelled", async ({ page }) => {
    const created = await buyEarlyBird(page, "s3");
    await payCheckoutSession(created.stripe_checkout_session_id);
    await page.goto(`/api/events/cart/release?orderId=${created.id}&eventSlug=${fixture.events.orgEarly.slug}&holdToken=${created.metadata.holdToken}`);
    await page.waitForURL(/success=paid/, { timeout: 60_000 });
    const final = await waitFor(() => order(created.id), (o) => o.payment_status === "paid");
    expect(final).toMatchObject({ status: "confirmed", payment_status: "paid", settlement_state: "paid" });
    const purchase = await readEventPurchase(config, fixture.events.orgEarly.id);
    expect(purchase.registrations.filter((r) => r.order_id === created.id).every((r) => r.status === "confirmed" && r.payment_status === "paid")).toBe(true);
    const { data: exceptions } = await admin().from("event_order_settlement_exceptions").select("kind").eq("order_id", created.id);
    expect(exceptions ?? []).toEqual([]);
  });

  test("S4 late payment after release (release whose Stripe expiry failed): never resurrected, actionable exception, no refund", async ({ page }) => {
    const created = await buyEarlyBird(page, "s4");
    // Set-up (labelled): the order is released in the database while its Stripe Session stays payable -- the state a
    // failed Stripe expiry would leave. The payment and its webhook below are real.
    const { data: attempts } = await admin().from("event_order_payment_attempts").select("id").eq("order_id", created.id);
    await admin().rpc("begin_event_cart_order_release", { p_order_id: created.id, p_reason: "e2e" });
    await admin().rpc("finalize_event_cart_order_release", { p_order_id: created.id, p_findings: (attempts ?? []).map((a) => ({ attempt_id: a.id, stripe_state: "closed" })), p_final_state: "released" });
    expect(await order(created.id)).toMatchObject({ status: "cancelled" });

    await payCheckoutSession(created.stripe_checkout_session_id);
    const { data: exception } = await waitFor(
      async () => admin().from("event_order_settlement_exceptions").select("kind, status, stripe_payment_intent_id, stripe_checkout_session_id, amount_cents").eq("order_id", created.id).maybeSingle(),
      (result) => Boolean(result.data),
    );
    expect(exception).toMatchObject({ kind: "late_payment_after_release", status: "open", stripe_checkout_session_id: created.stripe_checkout_session_id, amount_cents: 3000 });
    expect(String(exception?.stripe_payment_intent_id)).toMatch(/^pi_/);
    expect(await order(created.id)).toMatchObject({ status: "cancelled", payment_status: "failed" });
    const purchase = await readEventPurchase(config, fixture.events.orgEarly.id);
    expect(purchase.registrations.filter((r) => r.order_id === created.id).every((r) => r.status === "cancelled")).toBe(true);
    const intent = await stripe.paymentIntents.retrieve(String(exception?.stripe_payment_intent_id), {}, onAccount);
    expect([intent.status, intent.amount_received]).toEqual(["succeeded", 3000]); // money is with the studio; nothing was refunded
    const refunds = await stripe.refunds.list({ payment_intent: intent.id }, onAccount);
    expect(refunds.data).toEqual([]);

    // PAY-WH-1A H-1: captured money is classified, its staff alert delivered (cron), and staff resolve it in the app.
    const { data: recorded } = await admin().from("event_order_settlement_exceptions").select("id, money_state, alert_status").eq("order_id", created.id).single();
    expect(recorded?.money_state).toBe("captured");
    const alertedRow = await waitFor(async () => {
      await runCron();
      return (await admin().from("event_order_settlement_exceptions").select("alert_status").eq("id", recorded!.id).single()).data;
    }, (row) => row?.alert_status === "sent", 60_000);
    expect(alertedRow?.alert_status).toBe("sent");
    const { data: notifications } = await admin().from("notifications").select("type, priority, studio_id").eq("dedupe_key", `payment_exception:${recorded!.id}`);
    expect(notifications).toEqual([{ type: "payment_exception", priority: "urgent", studio_id: fixture.studioId }]);
    const { data: emails } = await admin().from("outbound_deliveries").select("recipient_email, template_key, subject")
      .eq("related_id", recorded!.id).eq("channel", "email");
    expect(emails).toEqual([expect.objectContaining({ recipient_email: fixture.owner.email, template_key: "payment_exception_alert" })]);
    await runCron(); // replay of the worker: still exactly one notification and one email
    expect((await admin().from("outbound_deliveries").select("id").eq("related_id", recorded!.id)).data).toHaveLength(1);

    await signIn(page, fixture.owner, `/app/events/${fixture.events.orgEarly.id}/registrations`);
    await page.goto(`/app/events/${fixture.events.orgEarly.id}/registrations`);
    const item = page.getByTestId("payment-exception").filter({ hasText: "A buyer paid after their ticket hold was released" });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Buyer was charged");
    await expect(item).toContainText(String(exception?.stripe_payment_intent_id));
    await item.getByLabel("Acknowledge (optional note)").fill("Contacting the buyer");
    await item.getByRole("button", { name: "Acknowledge" }).click();
    await page.waitForURL(/success=payment_exception_acknowledged/);
    const acknowledged = page.getByTestId("payment-exception").filter({ hasText: "A buyer paid after their ticket hold was released" });
    await expect(acknowledged).toContainText("Acknowledged");
    await acknowledged.getByLabel("Resolution note (required)").fill("Refunded in the Stripe dashboard (E2E)");
    await acknowledged.getByRole("button", { name: "Mark resolved" }).click();
    await page.waitForURL(/success=payment_exception_resolved/);
    await expect(page.getByTestId("payment-exception").filter({ hasText: "A buyer paid after their ticket hold was released" })).toHaveCount(0);
    const { data: resolved } = await admin().from("event_order_settlement_exceptions").select("status, resolved_by, resolution_note, acknowledged_by").eq("id", recorded!.id).single();
    expect(resolved).toEqual({ status: "resolved", resolved_by: fixture.owner.id, acknowledged_by: fixture.owner.id, resolution_note: "Refunded in the Stripe dashboard (E2E)" });
    const { data: trail } = await admin().from("event_order_settlement_exception_events").select("action").eq("exception_id", recorded!.id).order("created_at");
    expect((trail ?? []).map((row) => row.action)).toEqual(expect.arrayContaining(["recorded", "alert_sent", "acknowledged", "resolved"]));
    expect(await order(created.id)).toMatchObject({ status: "cancelled", payment_status: "failed" }); // resolving moved nothing
  });

  test("S5 forged metadata: a Session not recorded for the order never settles it (delivery fails visibly)", async ({ page }) => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const real = await buyEarlyBird(page, "s5"); // a genuine pending order with its own recorded Session
    const pending = real.id;
    const forged = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: `e2e-stripe-${fixture.runId}-forged@example.com`,
      success_url: "https://example.com/ok",
      cancel_url: "https://example.com/cancel",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 100, product_data: { name: "Forged (test mode)" } } }],
      metadata: { source: "event_cart_order", order_id: pending, order_hold_token: real.metadata.holdToken },
      payment_intent_data: { metadata: { source: "event_cart_order", order_id: pending, order_hold_token: real.metadata.holdToken } },
    }, onAccount);
    await payCheckoutSession(forged.id);
    const { ledger } = await waitFor(
      () => ledgerFor([forged.id], since),
      ({ ledger: rows }) => rows.some((row) => row.event_type === "checkout.session.completed" && row.status === "failed"),
    );
    const failed = ledger.find((row) => row.event_type === "checkout.session.completed");
    expect(failed).toMatchObject({ status: "failed", error_message: "event_cart_mismatch_unknown_payment_reference" });
    expect(await order(pending)).toMatchObject({ status: "pending", payment_status: "pending", paid_at: null });
    expect((await stripe.checkout.sessions.retrieve(real.stripe_checkout_session_id, {}, onAccount)).status).toBe("open");
    // The captured money is not silent: an actionable exception names the unknown Session (no order is touched).
    const { data: unknown } = await admin().from("event_order_settlement_exceptions")
      .select("kind, order_id, status, amount_cents").eq("stripe_checkout_session_id", forged.id);
    expect(unknown).toEqual([{ kind: "unknown_payment_reference", order_id: null, status: "open", amount_cents: 100 }]);
    const { data: attributed } = await admin().from("event_order_settlement_exceptions").select("studio_id, money_state, alert_status").eq("stripe_checkout_session_id", forged.id).single();
    expect(attributed).toMatchObject({ studio_id: fixture.studioId, money_state: "captured" });
    await admin().from("event_order_settlement_exceptions").delete().eq("stripe_checkout_session_id", forged.id);
  });

  test("S6 native PaymentSheet: recorded attempt, real payment settles once, PaymentIntent replay is idempotent", async ({ request }) => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const token = await studentAccessToken(config, fixture);
    const response = await request.post(`/api/student/events/${fixture.events.orgNative.id}/checkout`, {
      headers: { authorization: `Bearer ${token}`, "x-forwarded-for": `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      data: { clientRequestId: randomUUID(), paymentMode: "payment_sheet", buyerFirstName: "Nat", buyerLastName: "Student", ticketSelections: [{ ticketTypeId: fixture.tickets.native, quantity: 1, expectedUnitPriceCents: 3000 }] },
    });
    expect(response.status(), await response.text()).toBe(200);
    const body = await response.json();
    const intentId = String(body.clientSecret).split("_secret_")[0];
    expect((await stripe.paymentIntents.retrieve(intentId, {}, onAccount)).payment_method_types).toEqual(["card"]);
    const { data: attempts } = await admin().from("event_order_payment_attempts").select("kind, status, stripe_payment_intent_id").eq("order_id", body.orderId);
    expect(attempts).toEqual([{ kind: "payment_intent", status: "open", stripe_payment_intent_id: intentId }]);
    await stripe.paymentIntents.confirm(intentId, { payment_method: "pm_card_visa", return_url: "https://example.com/e2e" }, onAccount);
    const paid = await waitFor(() => order(body.orderId), (o) => o.payment_status === "paid");
    const { events } = await waitFor(() => ledgerFor([intentId], since), ({ ledger }) => ledger.some((row) => row.event_type === "payment_intent.succeeded" && row.status === "processed"));
    await Promise.all(events.filter((e) => e.type === "payment_intent.succeeded").map((event) => stripe.rawRequest("POST", `/v1/events/${event.id}/retry`, { for_stripecli: "true", account: ACCOUNT })));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect((await order(body.orderId)).paid_at).toBe(paid.paid_at);
    const purchase = await readEventPurchase(config, fixture.events.orgNative.id);
    expect(purchase.payments.filter((p) => p.stripe_payment_intent_id === intentId)).toHaveLength(1);
  });

  test("S7 interrupted outbox worker: its expired lease is recovered by the cron drain; the confirmation is queued once", async () => {
    const { data: paidOrder } = await admin().from("event_orders").select("id").eq("event_id", fixture.events.orgEarly.id).eq("payment_status", "paid").limit(1).single();
    // Set-up (labelled): simulate a worker that claimed the confirmation effect and died before completing it.
    await admin().from("event_settlement_outbox")
      .update({ status: "processing", claim_owner: randomUUID(), claim_expires_at: new Date(Date.now() - 1_000).toISOString(), next_attempt_at: new Date().toISOString() })
      .eq("order_id", paidOrder!.id)
      .eq("effect", "order_confirmation");
    const summary = await runCron();
    expect((summary.outbox as { claimed: number }).claimed).toBeGreaterThanOrEqual(1);
    const { data: effect } = await admin().from("event_settlement_outbox").select("status").eq("order_id", paidOrder!.id).eq("effect", "order_confirmation").single();
    expect(effect?.status).toBe("done");
    const { data: confirmations } = await admin().from("outbound_deliveries").select("id").eq("dedupe_key", `event_cart_order_confirmed:email:${paidOrder!.id}`);
    expect(confirmations ?? []).toHaveLength(1);
  });

  test("S8 expired hold: the sweeper expires the Stripe Session first and frees the capacity exactly once", async ({ page }) => {
    const created = await buyEarlyBird(page, "s8");
    // Set-up (labelled): the 35-minute hold is moved into the past instead of waiting for it.
    await admin().from("event_orders").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", created.id);
    await runCron();
    expect(await order(created.id)).toMatchObject({ status: "expired", payment_status: "failed", settlement_state: "expired" });
    const session = await stripe.checkout.sessions.retrieve(created.stripe_checkout_session_id, {}, onAccount);
    expect(session.status).toBe("expired");
    const again = await runCron();
    expect(JSON.stringify(again)).not.toContain(created.id);
  });

  test("S9 legacy order (created before PAY-WH-1, no attempt row): its stored Session is expired in Stripe before release", async ({ page }) => {
    const created = await buyEarlyBird(page, "s9");
    // Set-up (labelled): reduce the order to its pre-PAY-WH-1 shape -- only the order's own stored Session reference.
    await admin().from("event_order_payment_attempts").delete().eq("order_id", created.id);
    await admin().from("event_orders").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", created.id);
    await runCron();
    expect(await order(created.id)).toMatchObject({ status: "expired", payment_status: "failed", settlement_state: "expired" });
    expect((await stripe.checkout.sessions.retrieve(created.stripe_checkout_session_id, {}, onAccount)).status).toBe("expired");
    const { data: attempts } = await admin().from("event_order_payment_attempts").select("surface, status").eq("order_id", created.id);
    expect(attempts).toEqual([{ surface: "legacy", status: "closed" }]);
  });
});
