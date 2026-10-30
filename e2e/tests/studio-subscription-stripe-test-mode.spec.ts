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
  const state: { subscriptionId?: string; sessionId?: string } = {};
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
    fixture = await createStudioSubscriptionFixture(config);
  });

  test.afterAll(async () => {
    if (process.env.E2E_KEEP_FIXTURES === "true") return;
    // Stripe first: deleting the customers emits customer.subscription.deleted, which the app applies while the studio
    // rows still exist; then the database rows.
    await cleanupStripeTestObjects(stripe, await runStripeCustomerIds(config, fixture));
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    await cleanupStudioSubscriptionFixture(config, fixture);
  });

  test("B1 new subscriber: each plan's checkout opens a test Session on exactly the expected Price and amount; nothing is subscribed", async ({ browser }) => {
    const { context, page, request } = await signedInRequest(browser, fixture.fresh);
    for (const code of ["starter", "growth", "pro"] as const) {
      const offer = expectedOffer(code);
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
    await expect.poll(async () => (await readStudioBilling(config, fixture.fresh.id)).subscriptions[0]?.subscription_plan_id, { timeout: 60_000 }).toBe(fixture.planIds.growth);
    const billing = await readStudioBilling(config, fixture.fresh.id);
    expect(billing.subscriptions).toEqual([expect.objectContaining({ stripe_subscription_id: subscription.id, status: subscription.status, billing_interval: "month" })]);
    expect([billing.studio?.stripe_subscription_id, billing.studio?.subscription_status]).toEqual([subscription.id, subscription.status]);
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

    await expect.poll(async () => (await readStudioBilling(config, fixture.fresh.id)).subscriptions[0]?.subscription_plan_id, { timeout: 60_000 }).toBe(fixture.planIds.pro);
    const events = await stripe.events.list({ type: "customer.subscription.updated", created: { gte: since }, limit: 100 });
    const event = events.data.find((e) => (e.data.object as Stripe.Subscription).id === updated.id && (e.data.object as Stripe.Subscription).items.data[0]?.price.id === expectedOffer("pro").stripePriceId);
    expect(event, "customer.subscription.updated for the plan change").toBeTruthy();
    const settled = await readStudioBilling(config, fixture.fresh.id);
    // Still the column default after Growth and Pro: the known gap B5 records (so B5 fails for exactly that reason).
    expect(settled.studio?.billing_plan).toBe("starter");

    // Stripe re-delivers the authentic, already-processed event (what `stripe events resend` sends).
    await stripe.rawRequest("POST", `/v1/events/${event!.id}/retry`, { for_stripecli: "true" });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(await readStudioBilling(config, fixture.fresh.id)).toEqual(settled);
    expect((await readLedger(config, [event!.id])).map((r) => r.status)).toEqual(["processed"]);
    evidence({ subscription: updated.id, event: event!.id, plan: "pro" });
  });

  test("B5 known gap: studios.billing_plan follows a plan change (public embed/Discover read it)", async () => {
    test.fail(true, "PRICING-P1 follow-up: the subscription webhook does not update studios.billing_plan yet");
    expect((await readStudioBilling(config, fixture.fresh.id)).studio?.billing_plan).toBe("pro");
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

    const { context, request } = await signedInRequest(browser, fixture.legacy);
    const location = await startCheckout(request, "pro");
    expect(new URL(location).hostname).toBe("billing.stripe.com");
    expect((await stripe.checkout.sessions.list({ customer: customer.id, limit: 10 })).data).toHaveLength(0);
    const after = await stripe.subscriptions.retrieve(subscription.id);
    expect(after.items.data.map((i) => [i.price.id, i.price.unit_amount])).toEqual([[legacyPrice.id, legacyPrice.unit_amount]]);
    // The new-subscriber studio is unaffected.
    expect((await readStudioBilling(config, fixture.fresh.id)).subscriptions[0]?.subscription_plan_id).toBe(fixture.planIds.pro);
    await context.close();
    evidence({ subscription: subscription.id, legacyPrice: legacyPrice.id, legacyAmount: legacyPrice.unit_amount });
  });
});
