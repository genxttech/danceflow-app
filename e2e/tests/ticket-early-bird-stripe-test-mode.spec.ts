import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import {
  cleanupStripeTestModeFixture,
  createStripeTestModeFixture,
  readCrmCapture,
  readEventPurchase,
  readProviderEvents,
  setEarlyBirdCutoff,
  type StripeTestModeFixture,
} from "../helpers/stripeTestModeFixture";
import { completeCurrentSigningPage, waitForResumeAfterSigningToSettle } from "../helpers/signingPage";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * CI-A -- early-bird pricing through REAL Stripe TEST-mode payments, settled by REAL signed Stripe webhooks.
 *
 * Environment (see docs/qa/local-e2e-environment.md): local app + isolated local QA Supabase; Stripe TEST keys only
 * (the suite refuses live keys and non-local databases); direct charges on a Stripe TEST connected account; webhooks
 * delivered by `stripe listen --forward-connect-to`.
 *
 * Web cart: real browser UI to the real Stripe Checkout Session. The hosted page is not driven by automation (it runs
 * Stripe bot detection); the session is paid the way Stripe's own CLI completes test sessions (`stripe trigger
 * checkout.session.completed`): a tok_visa PaymentMethod confirmed through /v1/payment_pages/{session}/confirm with the
 * test key. Stripe then emits the authentic signed checkout.session.completed / payment_intent.succeeded events.
 * Native: the app's PaymentIntent is confirmed with Stripe's test method pm_card_visa (the PaymentSheet step).
 * Replay: Stripe re-delivers an already-processed event (POST /v1/events/{id}/retry, as `stripe events resend`).
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";

test.describe("Early-bird pricing through real Stripe test-mode payments (CI-A)", () => {
  test.skip(!TEST_KEY.startsWith("sk_test_") || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT), "Stripe TEST key and test connected account not provided");
  let config: E2EConfig;
  let fixture: StripeTestModeFixture;
  const stripe = new Stripe(TEST_KEY);
  const onAccount = { stripeAccount: ACCOUNT };

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    const balance = await stripe.balance.retrieve();
    if (balance.livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createStripeTestModeFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupStripeTestModeFixture(config, fixture);
  });

  const cartForm = (page: Page) => page.locator('form[action="/api/events/cart/checkout"]').filter({ visible: true }).first();
  const cents = (value: unknown) => Math.round(Number(value) * 100);
  const sum = (rows: Record<string, unknown>[], key: string) => rows.reduce((total, row) => total + cents(row[key]), 0);
  const buyerEmail = (tag: string) => `e2e-stripe-${fixture.runId}-${tag}@example.com`;
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });

  async function fillBuyer(page: Page, tag: string) {
    const form = cartForm(page);
    await form.locator('input[name="attendeeFirstName"]').fill("Pat");
    await form.locator('input[name="attendeeLastName"]').fill("Buyer");
    await form.locator('input[name="attendeeEmail"]').fill(buyerEmail(tag));
  }

  /** The browser has been redirected to Stripe's hosted Checkout; return the app's real session, read back from Stripe. */
  async function reachedStripeCheckout(page: Page, eventId: string, buyer?: string) {
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    const purchase = await readEventPurchase(config, eventId);
    const order = buyer ? purchase.orders.find((o) => String(o.buyer_email ?? "") === buyer) ?? purchase.orders.at(-1)! : purchase.orders.at(-1)!;
    const sessionId = order.stripe_checkout_session_id as string;
    expect(page.url()).toContain(sessionId);
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] }, onAccount);
    expect([session.livemode, session.status, session.payment_status]).toEqual([false, "open", "unpaid"]);
    return { session, orderId: order.id as string };
  }

  /** Pays an open Checkout Session in TEST mode exactly as `stripe trigger checkout.session.completed` does. */
  async function payCheckoutSession(sessionId: string, token = "tok_visa") {
    const paymentPage = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {}, onAccount)) as unknown as { total_summary?: { due?: number }; livemode?: boolean };
    expect(paymentPage.livemode).toBe(false);
    const session = await stripe.checkout.sessions.retrieve(sessionId, {}, onAccount);
    const paymentMethod = await stripe.paymentMethods.create({ type: "card", card: { token }, billing_details: { name: "Pat Buyer", email: session.customer_email ?? session.customer_details?.email ?? undefined } }, onAccount);
    try {
      return await stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: paymentMethod.id, expected_amount: paymentPage.total_summary?.due }, onAccount);
    } catch (error) {
      const raw = (error as { raw?: { code?: string; param?: string; message?: string; decline_code?: string } }).raw;
      throw new Error(`Stripe test confirm failed: ${raw?.code ?? ""} ${raw?.decline_code ?? ""} ${raw?.param ?? ""} ${raw?.message ?? String(error)}`);
    }
  }

  async function waitForOrderPaid(eventId: string, orderId: string) {
    await expect.poll(async () => (await readEventPurchase(config, eventId)).orders.find((o) => o.id === orderId)?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    // Payment rows and fee details are written in the same delivery; give the handler a moment to finish.
    await expect.poll(async () => {
      const purchase = await readEventPurchase(config, eventId);
      const regIds = new Set(purchase.registrations.filter((r) => r.order_id === orderId).map((r) => r.id));
      return purchase.payments.filter((p) => regIds.has(p.registration_id)).length === regIds.size && regIds.size > 0;
    }, { timeout: 30_000 }).toBe(true);
    return readEventPurchase(config, eventId);
  }

  function orderSlice(purchase: Awaited<ReturnType<typeof readEventPurchase>>, orderId: string) {
    const registrations = purchase.registrations.filter((r) => r.order_id === orderId);
    const regIds = new Set(registrations.map((r) => r.id));
    return {
      order: purchase.orders.find((o) => o.id === orderId)!,
      items: purchase.items.filter((i) => i.order_id === orderId),
      registrations,
      payments: purchase.payments.filter((p) => regIds.has(p.registration_id)),
      attendees: purchase.attendees.filter((a) => regIds.has(a.registration_id)),
    };
  }

  test("W1 organizer event, active early bird, mixed cart: real test payment + signed webhook settle exactly the shown amount; 3% fee; tickets; sibling order untouched; Stripe replay is idempotent", async ({ page, browser }) => {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.orgEarly.slug}`);
    await page.getByRole("tab", { name: "Tickets" }).click();
    await expect(page.locator("article", { hasText: "Early Bird Pass" }).first().getByText("$30.00")).toBeVisible();
    await page.getByText("Open Registration Form").click();
    await expect(page.getByText("Early bird price · regular $40.00")).toBeVisible();
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.earlyBird}"]`).fill("2");
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.regular}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$85.00")).toBeVisible();
    await fillBuyer(page, "w1");
    await cartForm(page).locator('input[name="additionalAttendeeNames"]').fill("Second Guest");
    await cartForm(page).locator('button[type="submit"]').click();
    const a = await reachedStripeCheckout(page, fixture.events.orgEarly.id);
    expect(a.session.amount_total).toBe(8500);
    expect((a.session.line_items?.data ?? []).map((l) => [l.quantity, l.price?.unit_amount]).sort()).toEqual([[1, 2500], [2, 3000]].sort());

    // A sibling buyer's pending order on the same event (its own Checkout Session, never paid).
    const siblingPage = await (await browser.newContext()).newPage();
    await assignUniqueSourceIp(siblingPage);
    await siblingPage.goto(`/events/${fixture.events.orgEarly.slug}`);
    await siblingPage.getByText("Open Registration Form").click();
    await cartForm(siblingPage).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.earlyBird}"]`).fill("1");
    await fillBuyer(siblingPage, "w1-sibling");
    await cartForm(siblingPage).locator('button[type="submit"]').click();
    await siblingPage.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    const siblingOrderId = (await readEventPurchase(config, fixture.events.orgEarly.id)).orders.find((o) => o.id !== a.orderId)!.id as string;
    const siblingBefore = orderSlice(await readEventPurchase(config, fixture.events.orgEarly.id), siblingOrderId);

    const startedAt = Math.floor(Date.now() / 1000) - 5;
    await payCheckoutSession(a.session.id);
    const settled = orderSlice(await waitForOrderPaid(fixture.events.orgEarly.id, a.orderId), a.orderId);
    const session = await stripe.checkout.sessions.retrieve(a.session.id, { expand: ["payment_intent"] }, onAccount);
    const intent = session.payment_intent as Stripe.PaymentIntent;
    expect([session.status, session.payment_status, intent.status, intent.amount, intent.application_fee_amount, intent.livemode]).toEqual(["complete", "paid", "succeeded", 8500, 255, false]);
    expect(settled.order.stripe_payment_intent_id).toBe(intent.id);
    expect(cents(settled.order.total_amount)).toBe(8500);
    const early = settled.items.find((item) => item.ticket_type_id === fixture.tickets.earlyBird)!;
    expect([cents(early.unit_price), cents(early.total_price), early.quantity]).toEqual([3000, 6000, 2]);
    expect(settled.registrations.every((r) => r.status === "confirmed" && r.payment_status === "paid")).toBe(true);
    expect(settled.payments).toHaveLength(settled.registrations.length);
    expect(sum(settled.payments, "amount")).toBe(8500);
    expect(settled.payments.every((p) => p.status === "paid" && p.stripe_payment_intent_id === intent.id && p.stripe_account_id === ACCOUNT)).toBe(true);
    expect(settled.attendees).toHaveLength(3);
    expect(new Set(settled.attendees.map((x) => x.ticket_code)).size).toBe(3);

    // Sibling order: untouched by this payment.
    const siblingAfter = orderSlice(await readEventPurchase(config, fixture.events.orgEarly.id), siblingOrderId);
    expect(siblingAfter).toEqual(siblingBefore);
    expect([siblingAfter.order.payment_status, siblingAfter.payments.length]).toEqual(["pending", 0]);

    // Lead policy: organizer listing -> organizer contact for the paid buyer only; no studio CRM lead.
    const crmPaid = await readCrmCapture(config, fixture, buyerEmail("w1"));
    expect([crmPaid.contacts.length, crmPaid.links.length, crmPaid.clients.length]).toEqual([1, settled.registrations.length, 0]);
    const crmSibling = await readCrmCapture(config, fixture, buyerEmail("w1-sibling"));
    expect([crmSibling.contacts.length, crmSibling.clients.length]).toEqual([0, 0]);

    // Replay: Stripe re-delivers the authentic, already-processed events; nothing is duplicated or changed.
    const events = await stripe.events.list({ created: { gte: startedAt }, limit: 50 }, onAccount);
    const replayed = events.data.filter((e) =>
      (e.type === "checkout.session.completed" && (e.data.object as Stripe.Checkout.Session).id === a.session.id) ||
      (e.type === "payment_intent.succeeded" && (e.data.object as Stripe.PaymentIntent).id === intent.id));
    expect(replayed.map((e) => e.type).sort()).toEqual(["checkout.session.completed", "payment_intent.succeeded"]);
    // Platform-scoped retry of the connected account's event (what `stripe events resend <id> --account <acct>` sends).
    for (const event of replayed) await stripe.rawRequest("POST", `/v1/events/${event.id}/retry`, { for_stripecli: "true", account: ACCOUNT });
    await page.waitForTimeout(10_000);
    const afterReplay = orderSlice(await readEventPurchase(config, fixture.events.orgEarly.id), a.orderId);
    expect(afterReplay.payments).toHaveLength(settled.payments.length);
    expect(sum(afterReplay.payments, "amount")).toBe(8500);
    expect(afterReplay.attendees.map((x) => x.ticket_code).sort()).toEqual(settled.attendees.map((x) => x.ticket_code).sort());
    expect([afterReplay.order.payment_status, cents(afterReplay.order.total_amount), afterReplay.order.stripe_payment_intent_id]).toEqual(["paid", 8500, intent.id]);
    expect(afterReplay.registrations.map((r) => [r.id, r.payment_status, cents(r.total_price)])).toEqual(settled.registrations.map((r) => [r.id, r.payment_status, cents(r.total_price)]));
    // One idempotency-ledger row per Stripe event, all processed: re-delivery never records or applies an event twice.
    // (Known, pre-existing ordering behaviour: payment_intent.succeeded can arrive before checkout.session.completed and is
    // then answered 500 until the session binds the PaymentIntent; its later successful processing may advance paid_at.)
    const ledger = await readProviderEvents(config, replayed.map((e) => e.id));
    expect(ledger.map((row) => [row.provider_event_id, row.status]).sort()).toEqual(replayed.map((e) => [e.id, "processed"]).sort());
    const crmAfterReplay = await readCrmCapture(config, fixture, buyerEmail("w1"));
    expect([crmAfterReplay.contacts.length, crmAfterReplay.links.length]).toEqual([1, settled.registrations.length]);
    expect(orderSlice(await readEventPurchase(config, fixture.events.orgEarly.id), siblingOrderId)).toEqual(siblingBefore);

    await stripe.checkout.sessions.expire(siblingAfter.order.stripe_checkout_session_id as string, {}, onAccount);
    await siblingPage.context().close();
    evidence({ session: a.session.id, intent: intent.id, amount: intent.amount, application_fee_amount: intent.application_fee_amount, replayedEvents: replayed.map((e) => e.id), payments: afterReplay.payments });
  });

  test("W2 organizer event, expired early bird: a declined test card leaves the order pending with no payment and no contact; a successful payment then settles the regular price", async ({ page }) => {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.orgExpired.slug}`);
    await page.getByText("Open Registration Form").click();
    await expect(page.getByText(/Early bird price · regular/)).toHaveCount(0);
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.expired}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$40.00").first()).toBeVisible();
    await fillBuyer(page, "w2");
    await cartForm(page).locator('button[type="submit"]').click();
    const { session, orderId } = await reachedStripeCheckout(page, fixture.events.orgExpired.id);
    expect(session.amount_total).toBe(4000);

    await expect(payCheckoutSession(session.id, "tok_chargeDeclined")).rejects.toThrow(/declined/i);
    await page.waitForTimeout(8_000);
    const declined = orderSlice(await readEventPurchase(config, fixture.events.orgExpired.id), orderId);
    expect([declined.order.payment_status, declined.payments.length]).toEqual(["pending", 0]);
    expect((await readCrmCapture(config, fixture, buyerEmail("w2"))).contacts).toHaveLength(0);

    await payCheckoutSession(session.id);
    const settled = orderSlice(await waitForOrderPaid(fixture.events.orgExpired.id, orderId), orderId);
    const intent = (await stripe.checkout.sessions.retrieve(session.id, { expand: ["payment_intent"] }, onAccount)).payment_intent as Stripe.PaymentIntent;
    expect([intent.status, intent.amount, intent.application_fee_amount]).toEqual(["succeeded", 4000, 120]);
    expect([cents(settled.items[0].unit_price), sum(settled.payments, "amount")]).toEqual([4000, 4000]);
    expect((await readCrmCapture(config, fixture, buyerEmail("w2"))).contacts).toHaveLength(1);
    evidence({ session: session.id, intent: intent.id, amount: intent.amount, application_fee_amount: intent.application_fee_amount });
  });

  test("W3 studio-hosted event, cutoff crosses while the form is open: refused with no order/session/lead; resubmitting pays the shown regular price with no DanceFlow fee and creates one studio lead", async ({ page }) => {
    await setEarlyBirdCutoff(config, fixture.tickets.race, new Date(Date.now() + 45_000).toISOString());
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.studioRace.slug}`);
    await page.getByText("Open Registration Form").click();
    await expect(page.getByText("Early bird price · regular $40.00")).toBeVisible();
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.race}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$30.00").first()).toBeVisible();
    await fillBuyer(page, "w3");
    await page.waitForTimeout(50_000);
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/error=ticket_price_changed/, { timeout: 60_000 });
    await expect(page.getByText(/You have not been charged/)).toBeVisible();
    expect((await readEventPurchase(config, fixture.events.studioRace.id)).orders).toHaveLength(0);
    expect((await readCrmCapture(config, fixture, buyerEmail("w3"))).clients).toHaveLength(0);

    await expect(page.getByText(/Early bird price · regular/)).toHaveCount(0);
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.race}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$40.00").first()).toBeVisible();
    await fillBuyer(page, "w3");
    await cartForm(page).locator('button[type="submit"]').click();
    const { session, orderId } = await reachedStripeCheckout(page, fixture.events.studioRace.id);
    expect(session.amount_total).toBe(4000);
    expect((await readCrmCapture(config, fixture, buyerEmail("w3"))).clients).toHaveLength(0); // pending: no lead yet
    await payCheckoutSession(session.id);
    const settled = orderSlice(await waitForOrderPaid(fixture.events.studioRace.id, orderId), orderId);
    const intent = (await stripe.checkout.sessions.retrieve(session.id, { expand: ["payment_intent"] }, onAccount)).payment_intent as Stripe.PaymentIntent;
    expect([intent.status, intent.amount, intent.application_fee_amount ?? null]).toEqual(["succeeded", 4000, null]);
    expect(cents(settled.items[0].unit_price)).toBe(4000);
    const crm = await readCrmCapture(config, fixture, buyerEmail("w3"));
    expect(crm.clients.map((c) => [c.status, c.referral_source])).toEqual([["lead", "Event Registration"]]);
    expect(crm.contacts).toHaveLength(0);
    evidence({ session: session.id, intent: intent.id, amount: intent.amount, application_fee_amount: intent.application_fee_amount ?? null, studioLead: crm.clients });
  });

  test("W4 waiver event: price confirmed at checkout is charged after signing, even when the early bird ends during signing; real payment settles", async ({ page }) => {
    await assignUniqueSourceIp(page);
    await page.goto(`/events/${fixture.events.orgDocs.slug}`);
    await page.getByText("Open Registration Form").click();
    await cartForm(page).locator(`input[name="ticketQuantityDisplay-${fixture.tickets.docs}"]`).fill("1");
    await expect(cartForm(page).locator("details", { hasText: "Your checkout" }).getByText("$30.00").first()).toBeVisible();
    await fillBuyer(page, "w4");
    await cartForm(page).locator('button[type="submit"]').click();
    await page.waitForURL(/\/sign\//, { timeout: 90_000 });
    await setEarlyBirdCutoff(config, fixture.tickets.docs, new Date(Date.now() - 1_000).toISOString());
    await completeCurrentSigningPage(page);
    await waitForResumeAfterSigningToSettle(page);
    const { session, orderId } = await reachedStripeCheckout(page, fixture.events.orgDocs.id);
    expect(session.amount_total).toBe(3000);
    await payCheckoutSession(session.id);
    const settled = orderSlice(await waitForOrderPaid(fixture.events.orgDocs.id, orderId), orderId);
    const intent = (await stripe.checkout.sessions.retrieve(session.id, { expand: ["payment_intent"] }, onAccount)).payment_intent as Stripe.PaymentIntent;
    expect([intent.status, intent.amount, intent.application_fee_amount]).toEqual(["succeeded", 3000, 90]);
    expect([cents(settled.items[0].unit_price), settled.registrations[0].payment_status, settled.attendees.length]).toEqual([3000, "paid", 1]);
    evidence({ session: session.id, intent: intent.id, amount: intent.amount, application_fee_amount: intent.application_fee_amount });
  });

  test("W5 native checkout API (PaymentSheet mode): lower shown price refused (409, no order, no contact); early-bird PaymentIntent paid with Stripe's test method settles via signed webhook", async ({ request }) => {
    const tokenResponse = await request.post(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      headers: { apikey: config.supabaseServiceRoleKey, "content-type": "application/json" },
      data: { email: fixture.student.email, password: fixture.student.password },
    });
    expect(tokenResponse.ok()).toBe(true);
    const accessToken = (await tokenResponse.json()).access_token as string;
    const checkout = (expectedUnitPriceCents: number) =>
      request.post(`/api/student/events/${fixture.events.orgNative.id}/checkout`, {
        headers: { authorization: `Bearer ${accessToken}`, "x-forwarded-for": `198.18.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
        data: {
          clientRequestId: randomUUID(), paymentMode: "payment_sheet", buyerFirstName: "Nat", buyerLastName: "Student",
          additionalAttendeeNames: ["Second Guest"],
          ticketSelections: [{ ticketTypeId: fixture.tickets.native, quantity: 2, expectedUnitPriceCents }],
        },
      });

    const refused = await checkout(2999);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("ticket_price_changed");
    expect((await readEventPurchase(config, fixture.events.orgNative.id)).orders).toHaveLength(0);
    expect((await readCrmCapture(config, fixture, fixture.student.email)).contacts).toHaveLength(0);

    const accepted = await checkout(3000);
    expect(accepted.status(), await accepted.text()).toBe(200);
    const body = await accepted.json();
    const intentId = String(body.clientSecret).split("_secret_")[0];
    const created = await stripe.paymentIntents.retrieve(intentId, {}, onAccount);
    expect([created.livemode, created.amount, created.application_fee_amount]).toEqual([false, 6000, 180]);
    const confirmed = await stripe.paymentIntents.confirm(intentId, { payment_method: "pm_card_visa", return_url: "https://example.com/e2e-return" }, onAccount);
    expect(confirmed.status).toBe("succeeded");
    const settled = orderSlice(await waitForOrderPaid(fixture.events.orgNative.id, body.orderId), body.orderId);
    expect([cents(settled.order.total_amount), settled.order.stripe_payment_intent_id]).toEqual([6000, intentId]);
    expect([cents(settled.items[0].unit_price), cents(settled.items[0].total_price), settled.items[0].quantity]).toEqual([3000, 6000, 2]);
    expect(settled.registrations.every((r) => r.status === "confirmed" && r.payment_status === "paid")).toBe(true);
    expect(sum(settled.payments, "amount")).toBe(6000);
    expect(settled.attendees).toHaveLength(2);
    expect((await readCrmCapture(config, fixture, fixture.student.email)).contacts).toHaveLength(1);
    evidence({ intent: intentId, amount: confirmed.amount, application_fee_amount: confirmed.application_fee_amount, payments: settled.payments });
  });
});
