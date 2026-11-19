import { test, expect, type Browser, type Page } from "@playwright/test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { buildDeliveryBody, deliverEvent, oldestFirst, signStripePayload, type RelayEvent } from "@/lib/e2e/stripeRelay";
import type { CompetitionAccount } from "../helpers/competitionFixture";
import {
  cleanupCompetitionFullEventFixture,
  createCompetitionFullEventFixture,
  type CompetitionFullEventFixture,
} from "../helpers/competitionFullEventFixture";
import { payCheckoutSession, readCompetitionRegistrations, type Couple, type CreatedEvent } from "../helpers/competitionFullEvent";
import { signIn } from "../helpers/competitionWizard";
import {
  createPricedCompetition,
  fillRefundForm,
  openRefundPage,
  openRegistration,
  readOrderMoney,
  readRefundLines,
  refundButton,
  registerCouples,
  signedInContext,
  stripeRefundsFor,
} from "../helpers/competitionFullEventMoney";
import { useUniqueE2ESourceIp as assignUniqueSourceIp } from "../helpers/rateLimitBypass";

/**
 * CF1 Stripe-TEST acceptance: failure handling and settlement integrity (complements competition-full-event.spec.ts, which covers
 * registration, refunds, scratch and tenant isolation). Same environment and the same skip rules, plus two optional variables for the
 * webhook-delivery tests, which need the event relay (scripts/qa/cf1-stripe-relay.ts) and the secret the app was started with:
 *   CF1_RELAY_WEBHOOK_SECRET  the app's STRIPE_CONNECT_WEBHOOK_SECRET (tests that sign deliveries themselves skip without it)
 *   CF1_RELAY_PAUSE_FILE      the relay's pause file (the out-of-order test skips without it)
 * Every state change goes through the DanceFlow UI or Stripe's TEST API on the sandbox connected account; the service-role client only
 * READS evidence. Nothing here moves real money: TEST key, TEST cards, loopback app, local database.
 *
 * NOT YET RUN against Stripe (authoring only; the run needs the owner-approved credential). Assumptions to confirm on the first run are
 * marked "ASSUMPTION"; a wrong assumption fails the test loudly rather than passing silently.
 */

test.describe.configure({ mode: "serial", timeout: 600_000 });

const FLAG_ON = process.env.E2E_COMPETITION_REGISTRATION_ENABLED === "true";
const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const ACCOUNT = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
const RELAY_SECRET = process.env.CF1_RELAY_WEBHOOK_SECRET ?? "";
const PAUSE_FILE = process.env.CF1_RELAY_PAUSE_FILE ?? "";
const ENTRY_FEE = 40;

test.describe("Stripe failure handling and settlement integrity", () => {
  test.skip(!FLAG_ON, "Needs the app started with NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED=true (E2E_COMPETITION_REGISTRATION_ENABLED=true).");
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY) || !/^acct_[A-Za-z0-9]+$/.test(ACCOUNT), "Stripe TEST key and test connected account not provided");

  let config: E2EConfig;
  let fixture: CompetitionFullEventFixture;
  let stripe: Stripe;
  let event: CreatedEvent;
  let webhookUrl: string;
  /** Orders created by this file that were paid, for the final reconciliation. */
  const paidOrders: string[] = [];
  let firstPaid: { orderId: string; sessionId: string; paymentIntent: string; startedAt: number } | undefined;

  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    webhookUrl = new URL("/api/payments/webhook", config.baseUrl).toString();
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    fixture = await createCompetitionFullEventFixture(config, { connectedAccountId: ACCOUNT });
  });

  test.afterAll(async () => {
    if (PAUSE_FILE && existsSync(PAUSE_FILE)) rmSync(PAUSE_FILE); // never leave the relay paused
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    await cleanupCompetitionFullEventFixture(config, fixture);
  });

  async function as(browser: Browser, account: CompetitionAccount): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, account);
    return page;
  }

  /** A buyer builds a cart on the public page and lands on the hosted Checkout page; returns the (still unpaid) session. */
  async function startCheckout(browser: Browser, label: string, couples: Couple[]) {
    const page = await (await browser.newContext()).newPage();
    await assignUniqueSourceIp(page);
    const email = `e2e-cf1fail-${fixture.runId}-${label}@example.com`;
    const checkoutUrl = await registerCouples(page, event.slug, { name: `Buyer ${label}`, email, phone: "5125550102" }, couples);
    const sessionId = checkoutUrl.match(/cs_test_[A-Za-z0-9]+/)?.[0];
    expect(sessionId, "hosted Checkout URL carries a test session").toBeTruthy();
    await page.context().close();
    return { sessionId: sessionId!, email };
  }

  const orderFor = async (sessionId: string) => (await readCompetitionRegistrations(config, event.id)).orders.find((order) => order.stripe_checkout_session_id === sessionId);

  /** Connected-account events created since `since` that mention any needle (a Checkout Session id, a PaymentIntent id). */
  async function eventsMentioning(since: number, needles: string[]): Promise<RelayEvent[]> {
    const found: RelayEvent[] = [];
    for await (const item of stripe.events.list({ created: { gte: since - 5 }, limit: 100 }, { stripeAccount: ACCOUNT })) {
      const text = JSON.stringify(item);
      if (needles.some((needle) => text.includes(needle))) found.push(item as unknown as RelayEvent);
    }
    return oldestFirst(found);
  }

  /** POST one delivery to the app and return status and body text (so a test can read "Already processed"). */
  async function post(body: string, signature: string | null) {
    const response = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) }, body });
    return { status: response.status, text: await response.text() };
  }

  const countPaid = async (orderId: string) => (await readOrderMoney(config, event.id, orderId)).payments.filter((row) => row.status === "paid").length;

  // ---------------------------------------------------------------- setup

  test("setup: a competition with registration open", async ({ browser }) => {
    const owner = await as(browser, fixture.owner);
    event = await createPricedCompetition(owner, config, { name: `E2E Failure Settlement ${fixture.runId}`, startDate: "2027-06-12", entryFee: ENTRY_FEE });
    await openRegistration(owner);
    await owner.context().close();
  });

  // ---------------------------------------------------------------- failure handling

  test("F1 declined card: nothing is charged, nothing is confirmed, the session stays open, and the buyer can retry and pay", async ({ browser }) => {
    const startedAt = nowSeconds();
    const { sessionId } = await startCheckout(browser, "decline", [{ leader: { firstName: "Dana", lastName: "Declined" }, follower: { firstName: "Eli", lastName: "Retry" } }]);
    // ASSUMPTION: tok_chargeDeclined becomes a PaymentMethod and the payment-page confirm fails with card_declined (thrown, or returned unpaid).
    const failure = await payCheckoutSession(stripe, ACCOUNT, sessionId, { token: "tok_chargeDeclined" }).then(() => null, (error: unknown) => error as Error);
    if (failure) expect(failure.message).toMatch(/declin/i);
    const open = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: ACCOUNT });
    expect([open.status, open.payment_status]).toEqual(["open", "unpaid"]);

    // Give a stray webhook time to arrive, then prove the app recorded no payment and confirmed no entry.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const order = await orderFor(sessionId);
    expect(order?.payment_status).not.toBe("paid");
    const state = await readCompetitionRegistrations(config, event.id);
    expect(state.payments.filter((payment) => payment.status === "paid")).toHaveLength(0);
    expect(state.entries.filter((entry) => entry.status === "confirmed")).toHaveLength(0);
    if (open.payment_intent) expect(await stripeRefundsFor(stripe, ACCOUNT, String(open.payment_intent))).toHaveLength(0);

    // The buyer retries with a good card on the same session and it settles once.
    const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId);
    expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
    // ASSUMPTION: a declined first attempt leaves the session payable (Stripe keeps a Checkout Session open after a card decline).
    await expect.poll(async () => (await orderFor(sessionId))?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    const settled = await orderFor(sessionId);
    expect(await countPaid(settled!.id as string)).toBe(1);
    paidOrders.push(settled!.id as string);
    firstPaid = { orderId: settled!.id as string, sessionId, paymentIntent: String(paid.payment_intent), startedAt };
    evidence({ test: "F1", declinedMessage: failure ? "card_declined-class error" : "returned unpaid", sessionAfterDecline: [open.status, open.payment_status], paidOrder: settled!.payment_status });
  });

  test("F2 abandoned checkout: an expired session releases the pending registration and never confirms an entry", async ({ browser }) => {
    const { sessionId } = await startCheckout(browser, "expire", [{ leader: { firstName: "Gus", lastName: "Abandon" }, follower: { firstName: "Hana", lastName: "Expire" } }]);
    // ASSUMPTION: the order and the cart already exist (linked to the session) while the session is open, before any webhook.
    const before = await readCompetitionRegistrations(config, event.id);
    const orderBefore = before.orders.find((order) => order.stripe_checkout_session_id === sessionId);
    const cartBefore = before.carts.find((cart) => cart.order_id === orderBefore?.id);
    expect(cartBefore, "the cart exists while the session is open").toBeTruthy();

    await stripe.checkout.sessions.expire(sessionId, {}, { stripeAccount: ACCOUNT });
    expect((await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: ACCOUNT })).status).toBe("expired");

    // The verified checkout.session.expired webhook releases the registration (Phase 10C). ASSUMPTION: the cart status changes from its open value.
    await expect.poll(async () => {
      const state = await readCompetitionRegistrations(config, event.id);
      return state.carts.find((cart) => cart.id === cartBefore!.id)?.status;
    }, { timeout: 90_000, intervals: [1_000] }).not.toBe(cartBefore!.status);

    const after = await readCompetitionRegistrations(config, event.id);
    expect(after.orders.find((order) => order.stripe_checkout_session_id === sessionId)?.payment_status).not.toBe("paid");
    expect(after.entries.filter((entry) => entry.registration_cart_id === cartBefore!.id && entry.status === "confirmed")).toHaveLength(0);
    expect(after.payments.filter((payment) => payment.status === "paid")).toHaveLength(paidOrders.length);
    evidence({ test: "F2", cartStatusBefore: cartBefore!.status, cartStatusAfter: after.carts.find((cart) => cart.id === cartBefore!.id)?.status });
  });

  test("F3 webhook integrity: a bad or missing signature is refused with nothing written, and a duplicate delivery of a processed event changes nothing", async () => {
    test.skip(!RELAY_SECRET, "Needs CF1_RELAY_WEBHOOK_SECRET (the app's connect webhook secret).");
    expect(firstPaid, "F1 must have produced a paid order").toBeTruthy();
    const completed = (await eventsMentioning(firstPaid!.startedAt, [firstPaid!.sessionId])).filter((item) => item.type === "checkout.session.completed");
    expect(completed.length, "Stripe holds the checkout.session.completed event for the paid session").toBeGreaterThan(0);
    // The app's claim keys on the event id, so this holds whether the original delivery came from the relay or from `stripe listen`.
    const target = completed[0];
    const before = await readOrderMoney(config, event.id, firstPaid!.orderId);

    const body = buildDeliveryBody(target, ACCOUNT);
    const now = nowSeconds();
    expect((await post(body, signStripePayload(body, "whsec_not_the_apps_secret", now))).status).toBe(400);
    expect((await post(body, null)).status).toBe(400);
    expect((await post(body + " ", signStripePayload(body, RELAY_SECRET, now))).status).toBe(400);

    // Three simultaneous duplicates of an event the app has already processed: all acknowledged, none processed again.
    const outcomes = await Promise.all([0, 1, 2].map(() => deliverEvent({
      url: webhookUrl, secret: RELAY_SECRET, event: target, account: ACCOUNT, nowSeconds,
      post: async ({ body: payload, signature }) => (await post(payload, signature)).status,
    })));
    expect(outcomes.map((outcome) => outcome.status)).toEqual([200, 200, 200]);
    const text = (await post(body, signStripePayload(body, RELAY_SECRET, nowSeconds()))).text;
    expect(text).toMatch(/already processed/i);

    const after = await readOrderMoney(config, event.id, firstPaid!.orderId);
    expect(after.payments.filter((row) => row.status === "paid")).toHaveLength(before.payments.filter((row) => row.status === "paid").length);
    expect(after.order).toMatchObject({ payment_status: before.order.payment_status, total_amount: before.order.total_amount });
    expect(after.entries.map((entry) => entry.status)).toEqual(before.entries.map((entry) => entry.status));
    evidence({ test: "F3", badSignature: 400, missingSignature: 400, tamperedBody: 400, duplicates: outcomes.map((o) => o.status), replayBody: "already processed" });
  });

  test("F4 out-of-order delivery: the session's events delivered newest first settle the order once, with no 5xx; the relay's later in-order pass changes nothing", async ({ browser }) => {
    test.skip(!RELAY_SECRET || !PAUSE_FILE, "Needs CF1_RELAY_WEBHOOK_SECRET and CF1_RELAY_PAUSE_FILE (the relay must be running).");
    const startedAt = nowSeconds();
    writeFileSync(PAUSE_FILE, "paused by F4\n");
    let sessionId = "";
    const statuses: Array<[string, number]> = [];
    let paymentIntent = "";
    try {
      ({ sessionId } = await startCheckout(browser, "ooo", [{ leader: { firstName: "Ivo", lastName: "Reverse" }, follower: { firstName: "Jules", lastName: "Order" } }]));
      const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId);
      expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
      paymentIntent = String(paid.payment_intent);

      // Stripe creates the events asynchronously; wait until the settling event and the charge/payment-intent events exist.
      let events: RelayEvent[] = [];
      await expect.poll(async () => {
        events = await eventsMentioning(startedAt, [sessionId, paymentIntent]);
        const types = new Set(events.map((item) => item.type));
        return types.has("checkout.session.completed") && types.has("payment_intent.succeeded");
      }, { timeout: 90_000, intervals: [2_000] }).toBe(true);

      // While the relay is paused the app has received nothing for this session.
      expect((await orderFor(sessionId))?.payment_status).not.toBe("paid");

      // Deliver newest first (so payment_intent/charge events arrive before checkout.session.completed).
      for (const item of [...events].reverse()) {
        const result = await deliverEvent({
          url: webhookUrl, secret: RELAY_SECRET, event: item, account: ACCOUNT, nowSeconds,
          post: async ({ body, signature }) => (await post(body, signature)).status,
        });
        statuses.push([item.type, result.status]);
      }
      expect(statuses.filter(([, status]) => status >= 500), "no event may produce a 5xx when delivered out of order").toEqual([]);
    } finally {
      if (existsSync(PAUSE_FILE)) rmSync(PAUSE_FILE);
    }

    await expect.poll(async () => (await orderFor(sessionId))?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    const order = await orderFor(sessionId);
    expect(await countPaid(order!.id as string)).toBe(1);
    // The relay resumes and re-delivers the same events in order: acknowledged as already processed, nothing changes.
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const after = await readOrderMoney(config, event.id, order!.id as string);
    expect(after.payments.filter((row) => row.status === "paid")).toHaveLength(1);
    expect(after.order.payment_status).toBe("paid");
    paidOrders.push(order!.id as string);
    evidence({ test: "F4", deliveredNewestFirst: statuses, finalOrder: after.order.payment_status });
  });

  // ---------------------------------------------------------------- settlement integrity

  let refundOrder: { id: string; paymentIntent: string } | undefined;

  test("S1 a two-entry order is paid and one entry is refunded through the UI (input for the reconciliation)", async ({ browser }) => {
    const { sessionId } = await startCheckout(browser, "settle", [
      { leader: { firstName: "Kai", lastName: "Ledger" }, follower: { firstName: "Lia", lastName: "Balance" } },
      { leader: { firstName: "Moe", lastName: "Totals" }, follower: { firstName: "Nia", lastName: "Net" } },
    ]);
    const paid = await payCheckoutSession(stripe, ACCOUNT, sessionId);
    expect([paid.status, paid.payment_status]).toEqual(["complete", "paid"]);
    await expect.poll(async () => (await orderFor(sessionId))?.payment_status, { timeout: 90_000, intervals: [1_000] }).toBe("paid");
    const order = await orderFor(sessionId);
    const orderId = order!.id as string;
    paidOrders.push(orderId);
    refundOrder = { id: orderId, paymentIntent: String(paid.payment_intent) };

    const { context, page } = await signedInContext(browser, fixture.owner);
    await openRefundPage(page, event.id, orderId);
    const entryLines = (await readRefundLines(page)).filter((line) => line.kind === "entry");
    expect(entryLines).toHaveLength(2);
    await fillRefundForm(page, { amounts: { [entryLines[0].itemId]: entryLines[0].remainingCents }, reason: "S1 settlement scenario" });
    await refundButton(page).click();
    await expect(page.getByRole("status")).toContainText("Refund Succeeded", { timeout: 60_000 });
    await expect.poll(async () => (await readOrderMoney(config, event.id, orderId)).refunds.map((refund) => refund.status), { timeout: 60_000 }).toEqual(["succeeded"]);
    await context.close();
  });

  test("S2 settlement reconciliation: for every paid order of this run the database, the ledger and Stripe agree to the cent", async () => {
    expect(paidOrders.length, "orders paid by F1, F4 and S1").toBeGreaterThanOrEqual(2);
    let stripeReceived = 0, stripeRefunded = 0, dbPaid = 0, dbRefunded = 0, orderTotals = 0;
    const perOrder: Array<Record<string, unknown>> = [];
    for (const orderId of paidOrders) {
      const money = await readOrderMoney(config, event.id, orderId);
      const paidRows = money.payments.filter((row) => ["paid", "partially_refunded", "refunded"].includes(String(row.status)));
      expect(paidRows.length, `order ${orderId.slice(0, 8)} has a payment row`).toBeGreaterThan(0);
      const intents = [...new Set(paidRows.map((row) => String(row.stripe_payment_intent_id)))];
      expect(intents, "one PaymentIntent per order").toHaveLength(1);
      const intent = await stripe.paymentIntents.retrieve(intents[0], {}, { stripeAccount: ACCOUNT });
      expect(intent.livemode).toBe(false);
      const orderCents = Math.round(Number(money.order.total_amount) * 100);
      const rowCents = paidRows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
      expect(intent.amount_received, "Stripe received exactly the order total").toBe(orderCents);
      expect(rowCents, "payment rows add up to the order total").toBe(orderCents);

      const stripeRefunds = (await stripeRefundsFor(stripe, ACCOUNT, intents[0])).filter((refund) => refund.status === "succeeded");
      const stripeRefundCents = stripeRefunds.reduce((sum, refund) => sum + refund.amount, 0);
      const dbRefundRows = money.refunds;
      expect(dbRefundRows.every((refund) => refund.status === "succeeded"), "no pending or failed refund rows are left behind").toBe(true);
      const dbRefundCents = dbRefundRows.reduce((sum, refund) => sum + Number(refund.amount_cents), 0);
      expect(dbRefundCents, "refund rows equal Stripe's refunds").toBe(stripeRefundCents);
      expect(new Set(dbRefundRows.map((refund) => String(refund.stripe_refund_id))), "every refund row points at a real Stripe refund and vice versa").toEqual(new Set(stripeRefunds.map((refund) => refund.id)));
      expect(rowRefundCents(paidRows), "payment rows carry the refunded amount").toBe(stripeRefundCents);
      const expectedStatus = stripeRefundCents === 0 ? "paid" : stripeRefundCents >= orderCents ? "refunded" : "partially_refunded";
      expect(money.order.payment_status).toBe(expectedStatus);

      stripeReceived += intent.amount_received; stripeRefunded += stripeRefundCents; dbPaid += rowCents; dbRefunded += dbRefundCents; orderTotals += orderCents;
      perOrder.push({ order: orderId.slice(0, 8), totalCents: orderCents, refundedCents: stripeRefundCents, status: money.order.payment_status });
    }
    // The dated refund entries in accounting equal the refunds (revenue is not voided, the refund is recorded when it succeeded).
    const accounting = (await readOrderMoney(config, event.id, refundOrder!.id)).refundAccounting;
    const ledgerRefundCents = accounting.reduce((sum, entry) => sum + Math.round(Number(entry.refund_amount ?? entry.gross_amount) * 100), 0);
    expect(ledgerRefundCents, "accounting refund entries equal the refunds").toBe(stripeRefunded);
    expect(accounting.every((entry) => entry.entry_status !== "voided")).toBe(true);
    // Net across the run: what Stripe holds equals what the app reports.
    expect(stripeReceived - stripeRefunded).toBe(orderTotals - dbRefunded);
    expect(dbPaid).toBe(orderTotals);
    // No payment row and no order of this event is left in an unexplained state.
    const state = await readCompetitionRegistrations(config, event.id);
    const unexplained = state.orders.filter((order) => !paidOrders.includes(order.id as string) && order.payment_status === "paid");
    expect(unexplained, "no paid order outside the reconciled set").toEqual([]);
    evidence({ test: "S2", orders: perOrder, netCents: stripeReceived - stripeRefunded });
  });

  const rowRefundCents = (rows: Array<Record<string, unknown>>) => rows.reduce((sum, row) => sum + Math.round(Number(row.refund_amount ?? 0) * 100), 0);
});
