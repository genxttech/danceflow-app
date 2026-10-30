import { test, expect, type APIRequestContext } from "@playwright/test";
import Stripe from "stripe";
import { loadE2EConfig, type E2EConfig } from "@/lib/e2e/config";
import { getBillingPlan } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { isRegularPricingActivated } from "@/lib/billing/regularPricing";
import { selectStudioMonthlyPrice } from "@/lib/billing/studioCheckoutPricing";
import { assertStripeCheckoutUrlIsTestMode } from "@/lib/payment-harness/browser";
import { signIn } from "../helpers/competitionWizard";
import {
  cleanupStripeTestObjects,
  cleanupStudioSubscriptionFixture,
  createStudioSubscriptionFixture,
  linkBillingCustomer,
  readLedger,
  readPlatformSubscriptionRows,
  readStudioBilling,
  runStripeCustomerIds,
  type StudioSubscriptionFixture,
  type SubscriptionStudio,
} from "../helpers/studioSubscriptionFixture";

/**
 * BILLING-QA-2 -- DanceFlow studio SUBSCRIPTION checkout and webhooks through REAL Stripe TEST mode, settled by REAL
 * signed PLATFORM-scoped webhooks. Same pattern as CI-A (ticket-early-bird-stripe-test-mode.spec.ts); see
 * docs/qa/local-e2e-environment.md section 3a for the platform-scoped run.
 *
 * Environment: local app + isolated local QA Supabase; Stripe TEST keys only (the suite refuses live keys and non-local
 * targets); webhooks delivered by `stripe listen --forward-to` (platform scope). The spec process must see the SAME
 * `STRIPE_PRICE_STUDIO_*` and pricing-flag variables as the app: expectations are computed with the app's own
 * `selectStudioMonthlyPrice`, so the suite checks whatever offer (Founder, or activated Regular) the app is running.
 *
 * Hosted Checkout and the Billing Portal pages are never driven (Stripe bot detection). Sessions are paid the way
 * Stripe's CLI completes test sessions (payment_pages confirm with a test card); a portal plan change is reproduced
 * with `subscriptions.update`, which produces the same signed `customer.subscription.updated` event.
 */

test.describe.configure({ mode: "serial", timeout: 300_000 });

const TEST_KEY = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
const LEGACY_PRO_PRICE = (process.env.STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY ?? "").split(",")[0].trim();
// The app's local `stripe listen` signing secret (test-only). With it, B9 re-sends authentic older Stripe event payloads
// under fresh event ids, i.e. genuinely delayed deliveries the ledger has not seen, to prove ordering safety.
const LISTEN_SECRET = process.env.E2E_STRIPE_WEBHOOK_SECRET ?? "";
type PlanCode = "starter" | "growth" | "pro";

function expectedOffer(code: PlanCode) {
  const plan = getBillingPlan(code);
  if (!plan) throw new Error(`no billing plan ${code}`);
  const selection = selectStudioMonthlyPrice({ plan, founderActive: isFounderPricingActive(), regularActivated: isRegularPricingActivated(), env: process.env });
  if (!selection.ok) throw new Error(`the spec environment cannot select a ${code} Price (${selection.reason}); give it the app's STRIPE_PRICE_STUDIO_* variables`);
  return selection;
}

test.describe("Studio subscription checkout and webhooks through real Stripe test mode (BILLING-QA-2)", () => {
  test.skip(!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(TEST_KEY), "Stripe TEST key not provided");
  let config: E2EConfig;
  let fixture: StudioSubscriptionFixture;
  let stripe: Stripe; // created in beforeAll, only when the suite actually runs
  const state: { subscriptionId?: string; sessionId?: string; extraCustomers: string[]; runStart: number; olderEvents: Stripe.Event[] } = {
    extraCustomers: [], runStart: 0, olderEvents: [],
  };

  /** The latest event of a type for an object since a time (the payloads B9 re-delivers late). */
  async function latestEvent(type: string, objectId: string, since: number, match: (o: Stripe.Subscription) => boolean = () => true) {
    const events = await stripe.events.list({ type, created: { gte: since }, limit: 100 });
    return events.data.find((e) => (e.data.object as Stripe.Subscription).id === objectId && match(e.data.object as Stripe.Subscription));
  }

  /** Waits for the subscription's plan AND studios.billing_plan (written right after it within the same delivery). */
  async function waitForPlan(studioId: string, plan: PlanCode) {
    await expect.poll(async () => {
      const billing = await readStudioBilling(config, studioId);
      return [billing.subscriptions[0]?.subscription_plan_id, billing.studio?.billing_plan];
    }, { timeout: 60_000 }).toEqual([fixture.planIds[plan], plan]);
  }

  /** POSTs an authentic older event payload under a fresh id, signed like `stripe listen` signs: a delayed delivery. */
  async function deliverLate(request: APIRequestContext, event: Stripe.Event, tag: string) {
    const body = JSON.stringify({ ...event, id: `evt_e2e_late_${fixture.runId}_${tag}` });
    const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret: LISTEN_SECRET } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    const response = await request.post("/api/payments/webhook", { data: body, headers: { "stripe-signature": signature, "content-type": "application/json" } });
    expect(response.status(), await response.text()).toBe(200);
  }
  const evidence = (value: unknown) => test.info().annotations.push({ type: "evidence", description: JSON.stringify(value) });

  /** Waits until the app's webhook ledger has processed a fresh platform event, proving `stripe listen` delivers. */
  async function waitForDelivered(type: string, objectId: string, since: number) {
    let eventId = "";
    await expect.poll(async () => {
      const events = await stripe.events.list({ type, created: { gte: since }, limit: 100 });
      eventId = events.data.find((e) => (e.data.object as { id?: string }).id === objectId)?.id ?? "";
      if (!eventId) return "no event yet";
      return (await readLedger(config, [eventId]))[0]?.status ?? "not delivered";
    }, { timeout: 60_000, intervals: [2_000], message: `${type} for ${objectId} was not processed by the app; is \`stripe listen --forward-to\` running with STRIPE_WEBHOOK_SECRET set to its secret?` }).toBe("processed");
    return eventId;
  }

  /** The app's checkout response for an authenticated owner, without following the redirect off the app. */
  async function startCheckout(request: APIRequestContext, planCode: PlanCode) {
    // Own synthetic source address per attempt: the route's real per-IP limit (8 / 10 min) stays untouched.
    const sourceIp = `10.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const response = await request.post("/api/billing/checkout", {
      form: { planCode, path: "studio" }, maxRedirects: 0, headers: { "x-forwarded-for": sourceIp },
    });
    expect(response.status(), await response.text()).toBe(303);
    return response.headers()["location"] ?? "";
  }

  async function signedInRequest(browser: import("@playwright/test").Browser, studio: SubscriptionStudio) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, studio.owner, "/app/settings/billing");
    return { context, page, request: page.request };
  }

  test.beforeAll(async () => {
    config = loadE2EConfig();
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.supabaseUrl)) throw new Error("refusing: not the local QA Supabase");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(config.baseUrl)) throw new Error("refusing: not a local app");
    stripe = new Stripe(TEST_KEY);
    if ((await stripe.balance.retrieve()).livemode) throw new Error("refusing: Stripe key is live");
    state.runStart = Math.floor(Date.now() / 1000) - 120; // tolerate local/Stripe clock skew
    fixture = await createStudioSubscriptionFixture(config);
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    // Stripe first: deleting the customers emits customer.subscription.deleted, which the app applies while the studio
    // rows still exist; then the database rows.
    await cleanupStripeTestObjects(stripe, [...(await runStripeCustomerIds(config, fixture)), ...state.extraCustomers]);
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await cleanupStudioSubscriptionFixture(config, fixture);
  });

  test("B1 new subscriber: each plan's checkout opens a test Session on exactly the expected Price and amount; nothing is subscribed", async ({ browser }) => {
    const { context, page, request } = await signedInRequest(browser, fixture.fresh);
    for (const code of ["starter", "growth", "pro"] as const) {
      const offer = expectedOffer(code);
      // Pinned literally as well, so a wrong amount in plans.ts cannot pass by agreeing with itself (approved Founder pricing).
      if (offer.offerType === "founder") expect(offer.expectedAmountCents).toBe({ starter: 5900, growth: 9900, pro: 15900 }[code]);
      const location = await startCheckout(request, code);
      const sessionId = assertStripeCheckoutUrlIsTestMode(location, `B1 ${code} checkout`);
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["line_items"] });
      const items = session.line_items?.data ?? [];
      expect([session.livemode, session.mode, session.status, session.payment_status]).toEqual([false, "subscription", "open", "unpaid"]);
      expect(items.map((l) => [l.price?.id, l.price?.unit_amount, l.price?.recurring?.interval, l.quantity])).toEqual([[offer.stripePriceId, offer.expectedAmountCents, "month", 1]]);
      expect(session.metadata).toMatchObject({ source: "studio_subscription", studioId: fixture.fresh.id, planCode: code, offerType: offer.offerType });
      await stripe.checkout.sessions.expire(sessionId);
      evidence({ plan: code, session: sessionId, price: offer.stripePriceId, amount: offer.expectedAmountCents, offer: offer.offerType });
    }

    // The browser itself follows the app's redirect to Stripe's hosted page (not driven further).
    await page.goto("/api/billing/checkout?planCode=growth&path=studio");
    await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
    state.sessionId = assertStripeCheckoutUrlIsTestMode(page.url(), "B1 browser redirect");

    const billing = await readStudioBilling(config, fixture.fresh.id);
    expect(billing.subscriptions).toHaveLength(0);
    expect(billing.customers).toHaveLength(1); // one Stripe customer reused across every attempt
    expect(billing.studio?.subscription_status).toBe("inactive");
    await context.close();
  });

  test("B2 paying the Growth Session: signed platform webhooks record a Growth subscription for exactly this studio", async () => {
    const sessionId = state.sessionId!;
    const since = Math.floor(Date.now() / 1000) - 120; // tolerate local/Stripe clock skew
    const page = (await stripe.rawRequest("GET", `/v1/payment_pages/${sessionId}`, {})) as unknown as { total_summary?: { due?: number }; livemode?: boolean };
    expect(page.livemode).toBe(false);
    // Subscription Sessions collect the card holder's name, so the test PaymentMethod carries billing details.
    const paymentMethod = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, billing_details: { name: "Pat Owner", email: fixture.fresh.owner.email } });
    try {
      await stripe.rawRequest("POST", `/v1/payment_pages/${sessionId}/confirm`, { payment_method: paymentMethod.id, expected_amount: page.total_summary?.due });
    } catch (error) {
      const raw = (error as { raw?: { code?: string; param?: string; message?: string } }).raw;
      throw new Error(`Stripe test confirm failed: ${raw?.code ?? ""} ${raw?.param ?? ""} ${raw?.message ?? String(error)}`);
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
    const subscription = session.subscription as Stripe.Subscription;
    expect([session.status, subscription.livemode]).toEqual(["complete", false]);
    expect(subscription.items.data.map((i) => i.price.id)).toEqual([expectedOffer("growth").stripePriceId]);
    state.subscriptionId = subscription.id;

    const completedEvent = await waitForDelivered("checkout.session.completed", sessionId, since);
    await waitForPlan(fixture.fresh.id, "growth");
    const billing = await readStudioBilling(config, fixture.fresh.id);
    expect(billing.subscriptions).toEqual([expect.objectContaining({ stripe_subscription_id: subscription.id, status: subscription.status, billing_interval: "month" })]);
    // Real Stripe objects: the billing period must reach the row whichever shape (subscription or items) this API version uses.
    const period = billing.subscriptions[0] as { current_period_start: string | null; current_period_end: string | null };
    expect([typeof period.current_period_start, typeof period.current_period_end]).toEqual(["string", "string"]);
    expect(Date.parse(period.current_period_end!)).toBeGreaterThan(Date.parse(period.current_period_start!));
    expect([billing.studio?.stripe_subscription_id, billing.studio?.subscription_status, billing.studio?.billing_plan]).toEqual([subscription.id, subscription.status, "growth"]);
    // Tenant isolation: the other studio is untouched.
    expect((await readStudioBilling(config, fixture.legacy.id)).subscriptions).toHaveLength(0);
    evidence({ session: sessionId, subscription: subscription.id, status: subscription.status, event: completedEvent });
  });

  test("B3 existing subscriber: checkout goes to the Billing Portal, creates no new Session and leaves the Price unchanged", async ({ browser }) => {
    const { context, request } = await signedInRequest(browser, fixture.fresh);
    const customer = String((await readStudioBilling(config, fixture.fresh.id)).customers[0].stripe_customer_id);
    const before = await stripe.checkout.sessions.list({ customer, limit: 100 });
    const location = await startCheckout(request, "pro");
    expect(new URL(location).hostname, "expected a Billing Portal redirect (is a test-mode portal configuration saved?)").toBe("billing.stripe.com");
    const after = await stripe.checkout.sessions.list({ customer, limit: 100 });
    expect(after.data.map((s) => s.id)).toEqual(before.data.map((s) => s.id));
    const subscription = await stripe.subscriptions.retrieve(state.subscriptionId!);
    expect(subscription.items.data.map((i) => i.price.id)).toEqual([expectedOffer("growth").stripePriceId]);
    await context.close();
  });

  test("B4 plan change Growth -> Pro (as the portal would): the webhook follows the Price, not the stale planCode metadata; replay changes nothing", async () => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const current = await stripe.subscriptions.retrieve(state.subscriptionId!);
    const updated = await stripe.subscriptions.update(current.id, {
      items: [{ id: current.items.data[0].id, price: expectedOffer("pro").stripePriceId }],
      proration_behavior: "none",
    });
    expect(updated.metadata.planCode).toBe("growth"); // written at checkout; deliberately stale now

    await waitForPlan(fixture.fresh.id, "pro");
    const events = await stripe.events.list({ type: "customer.subscription.updated", created: { gte: since }, limit: 100 });
    const event = events.data.find((e) => (e.data.object as Stripe.Subscription).id === updated.id && (e.data.object as Stripe.Subscription).items.data[0]?.price.id === expectedOffer("pro").stripePriceId);
    expect(event, "customer.subscription.updated for the plan change").toBeTruthy();
    const settled = await readStudioBilling(config, fixture.fresh.id);
    // Public embed / Discover read studios.billing_plan: it follows the plan change (BILLING-QA-3).
    expect(settled.studio?.billing_plan).toBe("pro");

    // Stripe re-delivers the authentic, already-processed event (what `stripe events resend` sends).
    await stripe.rawRequest("POST", `/v1/events/${event!.id}/retry`, { for_stripecli: "true" });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await readStudioBilling(config, fixture.fresh.id)).toEqual(settled);
    expect((await readLedger(config, [event!.id])).map((r) => r.status)).toEqual(["processed"]);
    evidence({ subscription: updated.id, event: event!.id, plan: "pro" });
  });

  test("B5 downgrade Pro -> Starter: subscription plan and studios.billing_plan both follow", async () => {
    const current = await stripe.subscriptions.retrieve(state.subscriptionId!);
    await stripe.subscriptions.update(current.id, {
      items: [{ id: current.items.data[0].id, price: expectedOffer("starter").stripePriceId }],
      proration_behavior: "none",
    });
    await waitForPlan(fixture.fresh.id, "starter");
    expect((await readStudioBilling(config, fixture.fresh.id)).studio?.billing_plan).toBe("starter");
  });

  test("B6 grandfathered Pro subscriber on a legacy Price: resolved as Pro by Price alone, sent to the portal, never re-priced", async ({ browser }) => {
    test.skip(!/^price_[A-Za-z0-9]+$/.test(LEGACY_PRO_PRICE), "STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY not provided (must match the app's)");
    const legacyPrice = await stripe.prices.retrieve(LEGACY_PRO_PRICE);
    expect([legacyPrice.livemode, legacyPrice.recurring?.interval]).toEqual([false, "month"]);
    expect(legacyPrice.id).not.toBe(expectedOffer("pro").stripePriceId);

    const since = Math.floor(Date.now() / 1000) - 120;
    const customer = await stripe.customers.create({
      email: fixture.legacy.owner.email, name: fixture.legacy.name, payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" }, metadata: { workspaceId: fixture.legacy.id, source: "danceflow_billing" },
    });
    await linkBillingCustomer(config, fixture.legacy.id, customer.id);
    // The listener gate: a fresh platform event must reach the app before anything depends on webhooks.
    await waitForDelivered("customer.created", customer.id, since);

    // No planCode in metadata: only the Price can identify the plan.
    const subscription = await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: legacyPrice.id }], trial_period_days: 30,
      metadata: { source: "studio_subscription", studioId: fixture.legacy.id, workspaceId: fixture.legacy.id },
    });
    await waitForDelivered("customer.subscription.created", subscription.id, since);
    const billing = await readStudioBilling(config, fixture.legacy.id);
    expect(billing.subscriptions).toEqual([expect.objectContaining({ subscription_plan_id: fixture.planIds.pro, stripe_subscription_id: subscription.id })]);
    expect(billing.studio?.billing_plan).toBe("pro");

    const { context, request } = await signedInRequest(browser, fixture.legacy);
    const location = await startCheckout(request, "pro");
    expect(new URL(location).hostname).toBe("billing.stripe.com");
    expect((await stripe.checkout.sessions.list({ customer: customer.id, limit: 10 })).data).toHaveLength(0);
    const after = await stripe.subscriptions.retrieve(subscription.id);
    expect(after.items.data.map((i) => [i.price.id, i.price.unit_amount])).toEqual([[legacyPrice.id, legacyPrice.unit_amount]]);
    // The new-subscriber studio is unaffected (still on Starter after B5).
    expect((await readStudioBilling(config, fixture.fresh.id)).subscriptions[0]?.subscription_plan_id).toBe(fixture.planIds.starter);
    await context.close();
    evidence({ subscription: subscription.id, legacyPrice: legacyPrice.id, legacyAmount: legacyPrice.unit_amount });
  });

  test("B7 a platform subscription without DanceFlow metadata (e.g. made in the Dashboard) is acknowledged, writing nothing", async () => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const customer = await stripe.customers.create({
      email: `e2e-billing-${fixture.runId}-unowned@e2e.test`, payment_method: "pm_card_visa", invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    state.extraCustomers.push(customer.id);
    const subscription = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: expectedOffer("growth").stripePriceId }], trial_period_days: 30 });
    // Previously answered 500 (stripe_subscriptions.studio_id null) and retried by Stripe; now processed with no write.
    await waitForDelivered("customer.subscription.created", subscription.id, since);
    expect(await readPlatformSubscriptionRows(config, subscription.id)).toEqual({ stripeSubscriptions: 0, studioSubscriptions: 0 });
    for (const s of [fixture.fresh, fixture.legacy]) expect((await readStudioBilling(config, s.id)).customers.map((c) => c.stripe_customer_id)).not.toContain(customer.id);
  });

  const statusOf = async (studioId: string) => (await readStudioBilling(config, studioId)).subscriptions[0]?.status;

  test("B8 trial ends with a failing card: invoice.payment_failed, past_due (no plan features), plan kept; paying the invoice restores active", async () => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const current = await stripe.subscriptions.retrieve(state.subscriptionId!);
    const customer = String(current.customer);
    const failing = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_chargeCustomerFail" }, billing_details: { name: "Pat Owner" } });
    await stripe.paymentMethods.attach(failing.id, { customer });
    // Ending the trial now bills the first real period with a card that attaches but always declines.
    await stripe.subscriptions.update(current.id, { default_payment_method: failing.id, trial_end: "now", proration_behavior: "none" }).catch(() => undefined);
    await expect.poll(() => statusOf(fixture.fresh.id), { timeout: 90_000, intervals: [2_000] }).toBe("past_due");
    const pastDue = await readStudioBilling(config, fixture.fresh.id);
    expect([pastDue.studio?.subscription_status, pastDue.studio?.billing_plan]).toEqual(["past_due", "starter"]);
    const invoiceId = String((await stripe.subscriptions.retrieve(current.id)).latest_invoice);
    await waitForDelivered("invoice.payment_failed", invoiceId, since);
    const pastDueEvent = await latestEvent("customer.subscription.updated", current.id, since, (o) => o.status === "past_due");
    expect(pastDueEvent, "customer.subscription.updated to past_due").toBeTruthy();
    state.olderEvents.push(pastDueEvent!);

    const good = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, billing_details: { name: "Pat Owner" } });
    await stripe.paymentMethods.attach(good.id, { customer });
    await stripe.invoices.pay(invoiceId, { payment_method: good.id });
    await expect.poll(() => statusOf(fixture.fresh.id), { timeout: 90_000, intervals: [2_000] }).toBe("active");
    const recovered = await readStudioBilling(config, fixture.fresh.id);
    expect([recovered.studio?.subscription_status, recovered.studio?.billing_plan]).toEqual(["active", "starter"]);
    evidence({ subscription: current.id, invoice: invoiceId, pastDueEvent: pastDueEvent!.id });
  });

  test("B9 delayed deliveries of authentic older events (past_due, the original Growth trial) do not overwrite newer state", async ({ request }) => {
    test.skip(!/^whsec_[A-Za-z0-9]+$/.test(LISTEN_SECRET), "E2E_STRIPE_WEBHOOK_SECRET (the local listen secret) not provided");
    const created = await latestEvent("customer.subscription.created", state.subscriptionId!, state.runStart);
    expect(created, "the original customer.subscription.created (Growth, trialing)").toBeTruthy();
    const before = await readStudioBilling(config, fixture.fresh.id);
    await deliverLate(request, state.olderEvents[0], "pastdue");
    await deliverLate(request, created!, "created");
    const after = await readStudioBilling(config, fixture.fresh.id);
    expect(after).toEqual(before);
    expect([after.subscriptions[0]?.status, after.subscriptions[0]?.subscription_plan_id, after.studio?.billing_plan]).toEqual(["active", fixture.planIds.starter, "starter"]);
    expect((await readLedger(config, [`evt_e2e_late_${fixture.runId}_pastdue`, `evt_e2e_late_${fixture.runId}_created`])).map((r) => r.status)).toEqual(["processed", "processed"]);
  });

  test("B10 cancellation: cancelled, no plan features, last plan kept; a late 'active' event cannot resurrect it", async ({ request }) => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const activeEvent = await latestEvent("customer.subscription.updated", state.subscriptionId!, state.runStart, (o) => o.status === "active");
    await stripe.subscriptions.cancel(state.subscriptionId!);
    await waitForDelivered("customer.subscription.deleted", state.subscriptionId!, since);
    const cancelled = await readStudioBilling(config, fixture.fresh.id);
    expect([cancelled.subscriptions[0]?.status, cancelled.studio?.subscription_status, cancelled.studio?.billing_plan]).toEqual(["cancelled", "cancelled", "starter"]);
    if (/^whsec_[A-Za-z0-9]+$/.test(LISTEN_SECRET) && activeEvent) {
      await deliverLate(request, activeEvent, "active-after-cancel");
      expect(await readStudioBilling(config, fixture.fresh.id)).toEqual(cancelled);
    }
  });

  test("B11 incomplete (never paid) subscription: recorded inactive, no plan features, billing_plan unchanged", async () => {
    const since = Math.floor(Date.now() / 1000) - 120;
    const customer = await stripe.customers.create({ email: fixture.edge.owner.email, metadata: { workspaceId: fixture.edge.id, source: "danceflow_billing" } });
    await linkBillingCustomer(config, fixture.edge.id, customer.id);
    const failing = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_chargeCustomerFail" }, billing_details: { name: "Pat Owner" } });
    await stripe.paymentMethods.attach(failing.id, { customer: customer.id });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: expectedOffer("pro").stripePriceId }], default_payment_method: failing.id, payment_behavior: "allow_incomplete",
      metadata: { source: "studio_subscription", studioId: fixture.edge.id, workspaceId: fixture.edge.id, planCode: "pro" },
    });
    expect(subscription.status).toBe("incomplete");
    await waitForDelivered("customer.subscription.created", subscription.id, since);
    const billing = await readStudioBilling(config, fixture.edge.id);
    expect(billing.subscriptions).toEqual([expect.objectContaining({ stripe_subscription_id: subscription.id, subscription_plan_id: fixture.planIds.pro, status: "inactive" })]);
    expect([billing.studio?.subscription_status, billing.studio?.billing_plan]).toEqual(["inactive", "starter"]);
  });

  test("B12 final billing state of every run studio, and no webhook delivery left failed", async () => {
    const [fresh, legacy, edge] = await Promise.all([fixture.fresh, fixture.legacy, fixture.edge].map((s) => readStudioBilling(config, s.id)));
    expect([fresh.subscriptions[0]?.status, fresh.subscriptions[0]?.subscription_plan_id, fresh.studio?.billing_plan]).toEqual(["cancelled", fixture.planIds.starter, "starter"]);
    if (/^price_[A-Za-z0-9]+$/.test(LEGACY_PRO_PRICE)) {
      expect([legacy.subscriptions[0]?.status, legacy.subscriptions[0]?.subscription_plan_id, legacy.studio?.billing_plan]).toEqual(["trialing", fixture.planIds.pro, "pro"]);
    }
    expect([edge.subscriptions[0]?.status, edge.studio?.billing_plan]).toEqual(["inactive", "starter"]);
    const ids = new Set([fresh, legacy, edge].flatMap((b) => b.subscriptions.map((s) => String(s.stripe_subscription_id))));
    const events = await stripe.events.list({ created: { gte: state.runStart }, limit: 100 }).autoPagingToArray({ limit: 2000 });
    const ours = events.filter((e) => {
      const object = e.data.object as { id?: string; subscription?: unknown };
      return ids.has(String(object.id)) || ids.has(String(typeof object.subscription === "string" ? object.subscription : ""));
    });
    const ledger = await readLedger(config, ours.map((e) => e.id));
    expect(ledger.filter((row) => row.status !== "processed").map((row) => `${row.event_type}:${row.status}`)).toEqual([]);
    evidence({ eventsChecked: ledger.length, fresh: fresh.subscriptions[0], legacy: legacy.subscriptions[0], edge: edge.subscriptions[0] });
  });
});
